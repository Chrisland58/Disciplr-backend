/**
 * Migration for Billing Events table
 *
 * Stores Stripe webhook events for organization billing.
 * Includes idempotency support via stripe_event_id uniqueness.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('billing_events', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    table.string('organization_id', 255).notNullable()
    table.string('stripe_event_id', 255).notNullable().unique()
    table.string('event_type', 255).notNullable()
    table.jsonb('raw_event').notNullable()
    table.timestamp('event_occurred_at', { useTz: true }).nullable()
    table.boolean('processed').notNullable().defaultTo(false)
    table.timestamp('processed_at', { useTz: true }).nullable()
    table.string('processing_status', 50).notNullable().defaultTo('pending')
    table.text('processing_error').nullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  await knex.schema.alterTable('billing_events', (table) => {
    table.index(['organization_id'], 'idx_billing_events_org_id')
    table.index(['stripe_event_id'], 'idx_billing_events_stripe_id')
    table.index(['event_type'], 'idx_billing_events_type')
    table.index(['processed'], 'idx_billing_events_processed')
    table.index(['created_at'], 'idx_billing_events_created_at')
    table.index(['organization_id', 'processed'], 'idx_billing_events_org_status')
  })
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('billing_events')
}
