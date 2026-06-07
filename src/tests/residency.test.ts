import { getReadDatabaseUrl } from '../middleware/orgAuth.js'

describe('Residency-aware read database URL resolution', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://default:5432/db'
    process.env.READ_DATABASE_URL_EU = 'postgresql://eu:5432/db'
    process.env.READ_DATABASE_URL_US = 'postgresql://us:5432/db'
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('returns the EU replica URL when residency is EU', () => {
    expect(getReadDatabaseUrl('EU')).toBe('postgresql://eu:5432/db')
  })

  it('returns the US replica URL when residency is US', () => {
    expect(getReadDatabaseUrl('US')).toBe('postgresql://us:5432/db')
  })

  it('falls back to DATABASE_URL when a regional replica is unset', () => {
    delete process.env.READ_DATABASE_URL_EU
    expect(getReadDatabaseUrl('EU')).toBe('postgresql://default:5432/db')
  })

  it('uses DATABASE_URL when residency is unset', () => {
    expect(getReadDatabaseUrl(undefined)).toBe('postgresql://default:5432/db')
  })
})
