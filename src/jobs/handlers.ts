import { NotificationService } from '../services/notifications/factory.js'
import { processJob as processExportJob } from '../services/exportQueue.js'
import type { JobHandler, JobType } from './types.js'
import { markVaultExpiries } from '../services/vaultExpiry.service.js'
import { cleanupExpiredSessions } from '../services/session.js'
import { buildSlashOnMissPayload } from '../services/soroban.js'

type JobHandlerRegistry = {
  [K in JobType]: JobHandler<K>
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

const logJob = (type: JobType, message: string): void => {
  console.log(`[jobs:${type}] ${message}`)
}

/**
 * Perform a best-effort startup probe to detect a broken NotificationService
 * early — before any job is dequeued — so misconfiguration is surfaced at
 * startup rather than silently exhausting maxAttempts per job at runtime.
 *
 * Fix #1290: the original code had no such check. A static/instance method
 * mismatch in NotificationService.send caused every notification job to throw
 * immediately, burning through retries and landing in the dead-letter queue.
 */
function validateNotificationService(service: NotificationService): void {
  if (typeof service.send !== 'function') {
    throw new Error(
      '[jobs] NotificationService.send is not a function — ' +
        'check for a static/instance method mismatch in the NotificationService class. ' +
        'All notification.send jobs will fail until this is resolved.',
    )
  }
}

export const createDefaultJobHandlers = (
  notificationService: NotificationService,
): JobHandlerRegistry => {
  // Fail fast at handler-registration time rather than per-job at dequeue time.
  validateNotificationService(notificationService)

  return {
    'notification.send': async (payload, context) => {
      // Fix #1290: wrap send in its own try/catch so that a provider-level
      // failure produces a structured log entry and a meaningful error message
      // rather than an unhandled rejection that only surfaces via queue
      // machinery.  The error is still re-thrown so the queue's retry /
      // dead-letter logic continues to operate normally.
      try {
        await notificationService.send(payload.recipient, payload.subject, payload.body)
        logJob('notification.send', `executed job_id=${context.jobId} attempt=${context.attempt}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(
          JSON.stringify({
            level: 'error',
            message: 'notification_send_failed',
            job_id: context.jobId,
            attempt: context.attempt,
            recipient: payload.recipient,
            subject: payload.subject,
            error: message,
          }),
        )
        throw err
      }
    },
    'deadline.check': async (payload, context) => {
      await sleep(30)
      const expiredCount = await markVaultExpiries()
      const target = payload.vaultId ?? 'all-active-vaults'
      const deadline = payload.deadlineIso ?? 'not-provided'
      logJob(
        'deadline.check',
        `checked target=${target} deadline=${deadline} expired=${expiredCount} source=${payload.triggerSource} attempt=${context.attempt}`,
      )
      if (payload.vaultId) {
        const sorobanPayload = buildSlashOnMissPayload(payload.vaultId)
        logJob(
          'deadline.check',
          `slash_on_miss built vault=${payload.vaultId} status=${sorobanPayload.submission.status}`,
        )
      }
    },
    'oracle.call': async (payload, context) => {
      await sleep(60)
      const requestId = payload.requestId ?? context.jobId
      logJob(
        'oracle.call',
        `oracle=${payload.oracle} symbol=${payload.symbol} requestId=${requestId} attempt=${context.attempt}`,
      )
    },
    'analytics.recompute': async (payload, context) => {
      await sleep(120)
      const entity = payload.entityId ?? 'all'
      const reason = payload.reason ?? 'unspecified'
      logJob(
        'analytics.recompute',
        `scope=${payload.scope} entity=${entity} reason=${reason} attempt=${context.attempt}`,
      )
    },
    'export.generate': async (payload, context) => {
      await processExportJob(payload.exportJobId, undefined, context.attempt)
      logJob(
        'export.generate',
        `exportJobId=${payload.exportJobId} attempt=${context.attempt}`,
      )
    },
    'sessions.cleanup': async (payload, context) => {
      const batchSize = payload.batchSize ?? 1000
      const deleted = await cleanupExpiredSessions(batchSize)
      logJob(
        'sessions.cleanup',
        `deleted=${deleted} batchSize=${batchSize} attempt=${context.attempt}`,
      )
    },
  }
}
