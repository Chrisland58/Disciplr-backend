import { createHmac } from 'node:crypto'
import type Stripe from 'stripe'
import { db } from '../db/index.js'

export interface BillingEvent {
  id: string
  organizationId: string
  stripeEventId: string
  eventType: string
  rawEvent: Stripe.Event
  eventOccurredAt: Date | null
  processed: boolean
  processedAt: Date | null
  processingStatus: 'pending' | 'processing' | 'completed' | 'failed'
  processingError: string | null
  createdAt: Date
}

/**
 * Service for handling Stripe webhook events
 * Verifies signatures, persists events, and manages idempotency
 */
export class BillingWebhookService {
  /**
   * Verify Stripe webhook signature
   * @param body - Raw request body as Buffer or string
   * @param signature - Stripe-Signature header value
   * @param secret - Stripe webhook signing secret
   * @returns Parsed event if valid, throws error otherwise
   */
  static verifyWebhookSignature(
    body: string | Buffer,
    signature: string | undefined,
    secret: string | undefined
  ): Stripe.Event {
    if (!signature || !secret) {
      throw new Error('Missing Stripe signature or webhook secret')
    }

    // Parse the body if it's a Buffer
    const bodyString = typeof body === 'string' ? body : body.toString('utf-8')

    // Stripe signature format: t=timestamp,v1=signature
    const parts = signature.split(',').reduce(
      (acc, part) => {
        const [key, value] = part.split('=')
        acc[key] = value
        return acc
      },
      {} as Record<string, string>
    )

    const timestamp = parts.t
    const stripeSignature = parts.v1

    if (!timestamp || !stripeSignature) {
      throw new Error('Invalid Stripe signature format')
    }

    // Verify timestamp is recent (within 5 minutes)
    const now = Math.floor(Date.now() / 1000)
    const receivedTime = parseInt(timestamp, 10)
    const timeDelta = Math.abs(now - receivedTime)

    if (timeDelta > 300) {
      throw new Error('Stripe webhook timestamp too old')
    }

    // Compute expected signature
    const signedContent = `${timestamp}.${bodyString}`
    const expectedSignature = createHmac('sha256', secret)
      .update(signedContent)
      .digest('hex')

    // Constant-time comparison to prevent timing attacks
    if (!constantTimeEqual(stripeSignature, expectedSignature)) {
      throw new Error('Invalid Stripe webhook signature')
    }

    // Parse and return the event
    const event = JSON.parse(bodyString) as Stripe.Event
    return event
  }

  /**
   * Check if a Stripe event has already been processed
   */
  static async isEventProcessed(stripeEventId: string): Promise<boolean> {
    const result = await db('billing_events')
      .where({ stripe_event_id: stripeEventId })
      .first()
    
    return !!result
  }

  /**
   * Get an existing billing event by stripe event ID
   */
  static async getEventByStripeId(stripeEventId: string): Promise<BillingEvent | null> {
    const result = await db('billing_events')
      .where({ stripe_event_id: stripeEventId })
      .first()
    
    return result ? mapRowToBillingEvent(result) : null
  }

  /**
   * Persist a new billing event to the database
   * Uses idempotency key (stripe_event_id) to ensure exactly-once delivery
   */
  static async persistEvent(
    organizationId: string,
    stripeEvent: Stripe.Event
  ): Promise<BillingEvent> {
    const now = new Date()
    
    // Try to insert; if it exists (duplicate), return the existing one
    try {
      const result = await db('billing_events').insert({
        organization_id: organizationId,
        stripe_event_id: stripeEvent.id,
        event_type: stripeEvent.type,
        raw_event: stripeEvent,
        event_occurred_at: new Date(stripeEvent.created * 1000),
        processed: false,
        processing_status: 'pending',
        created_at: now,
      }).returning('*')

      return mapRowToBillingEvent(result[0])
    } catch (error) {
      // Handle duplicate key error (idempotency)
      if ((error as any)?.code === '23505' || (error as any)?.message?.includes('unique')) {
        const existing = await this.getEventByStripeId(stripeEvent.id)
        if (existing) {
          return existing
        }
      }
      throw error
    }
  }

  /**
   * Update event processing status
   */
  static async updateProcessingStatus(
    id: string,
    status: 'pending' | 'processing' | 'completed' | 'failed',
    error?: string
  ): Promise<void> {
    const update: Record<string, any> = {
      processing_status: status,
    }

    if (status === 'completed') {
      update.processed = true
      update.processed_at = new Date()
    }

    if (error) {
      update.processing_error = error
    }

    await db('billing_events').where({ id }).update(update)
  }

  /**
   * Get unprocessed events for an organization
   */
  static async getUnprocessedEvents(organizationId: string, limit = 100): Promise<BillingEvent[]> {
    const results = await db('billing_events')
      .where({
        organization_id: organizationId,
        processed: false,
      })
      .orderBy('created_at', 'asc')
      .limit(limit)

    return results.map(mapRowToBillingEvent)
  }
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false
  }

  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }

  return result === 0
}

/**
 * Map database row to BillingEvent type
 */
function mapRowToBillingEvent(row: any): BillingEvent {
  return {
    id: row.id,
    organizationId: row.organization_id,
    stripeEventId: row.stripe_event_id,
    eventType: row.event_type,
    rawEvent: row.raw_event,
    eventOccurredAt: row.event_occurred_at ? new Date(row.event_occurred_at) : null,
    processed: row.processed,
    processedAt: row.processed_at ? new Date(row.processed_at) : null,
    processingStatus: row.processing_status,
    processingError: row.processing_error,
    createdAt: new Date(row.created_at),
  }
}
