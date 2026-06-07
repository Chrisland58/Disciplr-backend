import type { Knex } from 'knex'
import { EventProcessor } from '../services/eventProcessor.js'
import {
  setupTestDatabase,
  teardownTestDatabase,
  cleanAllTables,
  insertTestVault,
} from './helpers/testDatabase.js'
import { mockVaultCompletedEvent } from './fixtures/horizonEvents.js'

describe('EventProcessor idempotency key handling', () => {
  let db: Knex
  let processor: EventProcessor

  beforeAll(async () => {
    db = await setupTestDatabase()
    processor = new EventProcessor(db, { maxRetries: 3, retryBackoffMs: 50 })
  })

  afterAll(async () => {
    await teardownTestDatabase(db)
  })

  beforeEach(async () => {
    await cleanAllTables(db)
  })

  it('persists the canonical txHash:ledger:eventIndex key on processed events', async () => {
    await insertTestVault(db, 'vault-test-001', { status: 'active' })

    const result = await processor.processEvent(mockVaultCompletedEvent)
    expect(result.success).toBe(true)

    const processedEvent = await db('processed_events')
      .where({ event_id: mockVaultCompletedEvent.eventId })
      .first()

    expect(processedEvent).toBeDefined()
    expect(processedEvent.event_key).toBe(
      `${mockVaultCompletedEvent.transactionHash}:${mockVaultCompletedEvent.ledgerNumber}:${mockVaultCompletedEvent.eventIndex}`
    )
  })

  it('enforces event_key uniqueness even across distinct event_id values', async () => {
    await db('processed_events').insert({
      event_id: 'original-event',
      event_key: 'txhash-dup:100:1',
      transaction_hash: 'txhash-dup',
      event_index: 1,
      ledger_number: 100,
      processed_at: new Date(),
      created_at: new Date(),
    })

    await expect(
      db('processed_events').insert({
        event_id: 'duplicate-event',
        event_key: 'txhash-dup:100:1',
        transaction_hash: 'txhash-dup',
        event_index: 1,
        ledger_number: 100,
        processed_at: new Date(),
        created_at: new Date(),
      })
    ).rejects.toThrow()
  })
})
