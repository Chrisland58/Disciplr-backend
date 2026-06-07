# Enterprise Features Documentation

## Overview
The Disciplr Enterprise API provides dedicated endpoints for institutional users and savings groups. It enforces strict authorization and data exposure controls to ensure multi-tenant isolation and security.

## Authorization Flow
Enterprise access is managed through the `enterpriseGuard` middleware. Eligibility is determined by the `isEnterprise` flag in the JWT auth context, which is populated during authentication.

### Eligibility Criteria
- User must be authenticated.
- User must belong to an organization marked as an enterprise.
- The `enterpriseId` must be present in the auth context.

### Guard Behavior
- **Non-Enterprise Users**: Receive a `403 Forbidden` response.
- **Unauthenticated Requests**: Receive a `401 Unauthorized` response.
- **Unauthorized Access Attempts**: Logged to the security audit trail with the `security.enterprise_denied` event.

## Exposure Controls
The Enterprise API implements strict data exposure controls to prevent leakage of internal metadata:
1. **PII Masking**: Sensitive identifiers (e.g., creator addresses) are masked using deterministic hashing for observability.
2. **Public DTOs**: Internal database models are mapped to `EnterpriseVault` and `EnterpriseMilestone` DTOs, stripping fields like `created_at`, `updated_at`, and internal notes.
3. **Identifier Validation**: Enterprise identifiers are strictly retrieved from the verified auth context, preventing ID guessing or cross-tenant leakage.

## Rollout Approach
Enterprise features are controlled via a feature flag matrix:
- **`isEnterprise`**: Global flag per user/org.
- **`enterpriseId`**: Scopes data access to a specific tenant.

### Feature Flag Matrix
| Feature | Flag Requirement | Status |
|---|---|---|
| Enterprise Routes | `isEnterprise: true` | Active |
| Custom Milestones | `enterprise_custom_milestones: true` | In Development |
| Advanced Analytics | `enterprise_analytics_tier: 'premium'` | In Development |

## Security Assumptions
- JWTs are signed and cannot be tampered with.
- The `isEnterprise` flag is accurately populated by the Identity Provider or the core auth service.
- All enterprise-specific data is tagged with an `organization_id` for isolation.

## Billing Webhooks
The Disciplr API provides a secure webhook receiver for Stripe billing events, allowing external billing systems to send billing state changes to the platform.

### Endpoint
**POST** `/api/billing/webhooks`

### Authentication
Billing webhooks do not require JWT authentication. Instead, they use cryptographic signature verification via the `Stripe-Signature` header.

### Required Headers
- **`Stripe-Signature`**: Webhook signature from Stripe (format: `t=timestamp,v1=signature`)
- **`X-Organization-Id`**: Organization ID for multi-tenant routing

### Configuration
The webhook receiver requires the following environment variable:
```bash
STRIPE_WEBHOOK_SECRET=whsec_...  # From Stripe Dashboard → Webhooks
```

### Signature Verification
Stripe webhook signatures are verified using HMAC-SHA256:
1. Extract timestamp (`t`) and signature (`v1`) from `Stripe-Signature` header
2. Verify timestamp is within 5 minutes of current time (prevents replay attacks)
3. Compute `HMAC-SHA256(secret, timestamp.payload)` and compare with provided `v1`
4. Return `401 Unauthorized` if verification fails

### Event Processing
When a webhook is received:
1. **Verify signature** using the Stripe webhook secret
2. **Check idempotency** via `stripe_event_id` to prevent duplicate processing
3. **Persist event** to `billing_events` table for audit trail
4. **Enqueue job** for asynchronous processing via the job queue
5. **Return 202 Accepted** immediately (event is processed asynchronously)

### Request Example
```bash
curl -X POST https://api.disciplr.io/api/billing/webhooks \
  -H "Content-Type: application/json" \
  -H "Stripe-Signature: t=1234567890,v1=abc123def456..." \
  -H "X-Organization-Id: org-enterprise-1" \
  -d '{
    "id": "evt_1234567890",
    "object": "event",
    "type": "customer.subscription.created",
    "data": { ... }
  }'
```

### Response (202 Accepted)
```json
{
  "received": true,
  "eventId": "evt_1234567890",
  "type": "customer.subscription.created",
  "billingEventId": "uuid-here",
  "jobId": "job-uuid-here"
}
```

### Error Responses

#### 400 Bad Request
Invalid JSON payload or missing required fields.

#### 401 Unauthorized
- Missing or invalid `Stripe-Signature` header
- Webhook signature verification failed
- Timestamp too old (>5 minutes)

#### 403 Forbidden
Missing `X-Organization-Id` header.

#### 409 Conflict
Event with the same `stripe_event_id` already processed (idempotent - can retry safely).

#### 500 Internal Server Error
- Webhook secret not configured (`STRIPE_WEBHOOK_SECRET`)
- Database persistence failure

### Idempotency Guarantee
The billing webhook receiver provides exactly-once delivery semantics:
- Each Stripe event ID is stored in the `billing_events` table as a unique key
- Duplicate webhook deliveries return immediately with a `202` response
- Safe to retry failed requests without duplicate processing

### Database Schema
```sql
CREATE TABLE billing_events (
  id UUID PRIMARY KEY,
  organization_id VARCHAR(255) NOT NULL,
  stripe_event_id VARCHAR(255) NOT NULL UNIQUE,
  event_type VARCHAR(255) NOT NULL,
  raw_event JSONB NOT NULL,
  event_occurred_at TIMESTAMP,
  processed BOOLEAN DEFAULT FALSE,
  processing_status VARCHAR(50) DEFAULT 'pending',
  processing_error TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_billing_events_org_id ON billing_events(organization_id);
CREATE INDEX idx_billing_events_stripe_id ON billing_events(stripe_event_id);
CREATE INDEX idx_billing_events_processed ON billing_events(processed);
```

### Monitoring & Debugging
Events can be queried by organization:
```bash
SELECT * FROM billing_events 
WHERE organization_id = 'org-123'
ORDER BY created_at DESC
LIMIT 100;
```

Check processing status:
```bash
SELECT event_type, processing_status, COUNT(*) as count
FROM billing_events
WHERE organization_id = 'org-123'
GROUP BY event_type, processing_status;
```

Inspect failures:
```bash
SELECT stripe_event_id, event_type, processing_error
FROM billing_events
WHERE organization_id = 'org-123' AND processing_status = 'failed'
ORDER BY created_at DESC;
```

