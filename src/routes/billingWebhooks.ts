import { Router, type Request, type Response } from 'express'
import express from 'express'
import type { BackgroundJobSystem } from '../jobs/system.js'
import { BillingWebhookService } from '../services/billingWebhook.js'
import { getEnv } from '../config/index.js'

/**
 * Billing Webhooks Router
 * Handles Stripe webhook events for organization billing
 *
 * Path: POST /api/billing/webhooks
 * Signature Header: Stripe-Signature
 */
export function createBillingWebhooksRouter(jobSystem: BackgroundJobSystem): Router {
  const router = Router()
  const env = getEnv()

  /**
   * Raw body parser for this route only
   * Required for Stripe signature verification
   */
  const rawBodyParser = express.raw({ type: 'application/json', limit: '10mb' })

  /**
   * POST /api/billing/webhooks
   *
   * Receives and processes Stripe webhook events
   *
   * Headers:
   *   - Stripe-Signature: Stripe webhook signature (required)
   *   - X-Organization-Id: Organization ID (required) - header for enterprise tenants
   *
   * Body: Raw JSON event payload from Stripe
   *
   * Success Response (202):
   *   {
   *     "received": true,
   *     "eventId": "evt_...",
   *     "type": "customer.subscription.updated",
   *     "jobId": "job-id-here"
   *   }
   *
   * Error Responses:
   *   - 400: Bad Request (invalid payload)
   *   - 401: Unauthorized (missing/invalid signature)
   *   - 403: Forbidden (missing organization ID)
   *   - 409: Conflict (duplicate event)
   *   - 500: Internal Server Error
   */
  router.post(
    '/',
    rawBodyParser,
    async (req: Request, res: Response) => {
      try {
        // Extract organization ID from header
        const organizationId = req.header('x-organization-id')
        if (!organizationId) {
          return res.status(403).json({
            error: 'Missing required X-Organization-Id header',
            code: 'MISSING_ORG_ID',
          })
        }

        // Extract Stripe signature
        const signature = req.header('stripe-signature')
        if (!signature) {
          return res.status(401).json({
            error: 'Missing Stripe-Signature header',
            code: 'MISSING_SIGNATURE',
          })
        }

        // Get webhook secret from environment
        const webhookSecret = env.STRIPE_WEBHOOK_SECRET
        if (!webhookSecret) {
          console.error('[billing:webhook] STRIPE_WEBHOOK_SECRET not configured')
          return res.status(500).json({
            error: 'Webhook secret not configured',
            code: 'INTERNAL_ERROR',
          })
        }

        // Verify Stripe signature and parse event
        let stripeEvent
        try {
          stripeEvent = BillingWebhookService.verifyWebhookSignature(
            req.body,
            signature,
            webhookSecret
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error'
          console.warn('[billing:webhook] signature verification failed', {
            error: message,
            organizationId,
          })

          return res.status(401).json({
            error: 'Invalid webhook signature',
            code: 'INVALID_SIGNATURE',
            message,
          })
        }

        // Check for duplicate event (idempotency)
        const isProcessed = await BillingWebhookService.isEventProcessed(stripeEvent.id)
        if (isProcessed) {
          const existing = await BillingWebhookService.getEventByStripeId(stripeEvent.id)
          console.info('[billing:webhook] duplicate event received', {
            stripeEventId: stripeEvent.id,
            organizationId,
            existingId: existing?.id,
          })

          // Return 202 even for duplicates - idempotent success
          return res.status(202).json({
            received: true,
            eventId: stripeEvent.id,
            type: stripeEvent.type,
            isDuplicate: true,
            jobId: null,
          })
        }

        // Persist the event
        let billingEvent
        try {
          billingEvent = await BillingWebhookService.persistEvent(
            organizationId,
            stripeEvent
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error'
          console.error('[billing:webhook] failed to persist event', {
            error: message,
            stripeEventId: stripeEvent.id,
            organizationId,
          })

          return res.status(500).json({
            error: 'Failed to persist webhook event',
            code: 'PERSISTENCE_ERROR',
            message,
          })
        }

        // Enqueue job for asynchronous processing
        let jobId: string | null = null
        try {
          const receipt = await jobSystem.enqueue('billing.event.process', {
            billingEventId: billingEvent.id,
            organizationId,
          })
          jobId = receipt.id

          console.info('[billing:webhook] event processed successfully', {
            stripeEventId: stripeEvent.id,
            billingEventId: billingEvent.id,
            organizationId,
            eventType: stripeEvent.type,
            jobId,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error'
          console.error('[billing:webhook] failed to enqueue processing job', {
            error: message,
            billingEventId: billingEvent.id,
            stripeEventId: stripeEvent.id,
            organizationId,
          })

          // Still return 202 - event is persisted, job enqueue is best-effort
          return res.status(202).json({
            received: true,
            eventId: stripeEvent.id,
            type: stripeEvent.type,
            billingEventId: billingEvent.id,
            jobId: null,
            warning: 'Event persisted but job enqueue failed',
          })
        }

        // Success response
        return res.status(202).json({
          received: true,
          eventId: stripeEvent.id,
          type: stripeEvent.type,
          billingEventId: billingEvent.id,
          jobId,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        console.error('[billing:webhook] unexpected error', {
          error: message,
          organizationId: req.header('x-organization-id'),
        })

        return res.status(500).json({
          error: 'Internal server error',
          code: 'INTERNAL_ERROR',
          message,
        })
      }
    }
  )

  return router
}
