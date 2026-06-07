import { Request, Response, NextFunction } from 'express'
import { AuthenticatedRequest } from './auth.js'
import knex, { Knex } from 'knex'
import {
  getOrganization,
  getMemberRole as lookupMemberRole,
} from '../models/organizations.js'
import type { OrgRole, Residency } from '../models/organizations.js'
import db from '../db/index.js'

export type { OrgRole, Residency } from '../models/organizations.js'

const RESIDENCY_URL_ENV: Record<Residency, keyof NodeJS.ProcessEnv> = {
  EU: 'READ_DATABASE_URL_EU',
  US: 'READ_DATABASE_URL_US',
}

const readDbCache = new Map<string, Knex>()

export function getReadDatabaseUrl(residency?: Residency): string | undefined {
  if (residency) {
    const url = process.env[RESIDENCY_URL_ENV[residency]]
    if (url && url.trim() !== '') {
      return url
    }
  }
  return process.env.DATABASE_URL
}

export function getResidencyReadDb(residency?: Residency): Knex {
  const connectionString = getReadDatabaseUrl(residency)
  if (!connectionString) {
    return db
  }

  if (!readDbCache.has(connectionString)) {
    readDbCache.set(
      connectionString,
      knex({
        client: 'pg',
        connection: connectionString,
        pool: { min: 2, max: 10 },
      })
    )
  }

  return readDbCache.get(connectionString)!
}

async function getOrgResidency(orgId: string): Promise<Residency | undefined> {
  const organization = await db('organizations')
    .where({ id: orgId })
    .first(['residency'])

  const residency = organization?.residency
  return residency === 'EU' || residency === 'US' ? residency : undefined
}

async function getTeamOrganizationId(teamId: string): Promise<string | undefined> {
  const team = await db('teams').where({ id: teamId }).first(['organization_id'])
  return team?.organization_id
}

async function resolveReadDbForOrg(orgId?: string): Promise<Knex> {
  if (!orgId) {
    return db
  }

  const residency = await getOrgResidency(orgId)
  return getResidencyReadDb(residency)
}

/**
 * In-memory org access middleware (used by orgVaults routes).
 * Checks org existence and membership via in-memory store.
 */
export function requireOrgAccess(...allowedRoles: (OrgRole | string)[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const orgId = req.params.orgId || (req.query.orgId as string)
    const userId = req.user?.userId || (req.user as any)?.sub

    if (!orgId || !userId) {
      res.status(401).json({ error: 'Auth/Org info missing' })
      return
    }

    const org = getOrganization(orgId)
    if (!org) {
      res.status(404).json({ error: 'Organization not found' })
      return
    }
      (req as any).orgId = orgId

    const role = lookupMemberRole(orgId, userId)
    if (!role) {
      res.status(403).json({ error: 'Forbidden: not a member of this organization' })
      return
    }

    if (!allowedRoles.includes(role)) {
      res.status(403).json({ error: `Forbidden: requires role ${allowedRoles.join(' or ')}` })
      return
    }

    next()
  }
}

/**
 * DB-based org role middleware (used by enterprise routes).
 */
export const requireOrgRole = (roles: (OrgRole | string)[]) => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const orgId = req.params.orgId || (req.query.orgId as string)
    const userId = req.user?.userId || (req.user as any)?.sub

    if (!orgId || !userId) {
      res.status(401).json({ error: 'Auth/Org info missing' })
      return
    }

    try {
      const readDb = await resolveReadDbForOrg(orgId)
      const membership = await readDb('org_members').where({ org_id: orgId, user_id: userId }).first()
      if (!membership || !roles.includes(membership.role)) {
        res.status(403).json({ error: `Forbidden: requires organization role ${roles.join(' or ')}` })
        return
      }
      next()
    } catch {
      res.status(403).json({ error: `Forbidden: requires organization role ${roles.join(' or ')}` })
    }
  }
}

/**
 * DB-based team role middleware (used by enterprise routes).
 */
export const requireTeamRole = (roles: (OrgRole | string)[]) => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const teamId = req.params.teamId || (req.query.teamId as string)
    const userId = req.user?.userId || (req.user as any)?.sub

    if (!teamId || !userId) {
      res.status(401).json({ error: 'Auth/Team info missing' })
      return
    }

    try {
      const organizationId = await getTeamOrganizationId(teamId)
      const readDb = await resolveReadDbForOrg(organizationId)
      const membership = await readDb('team_members').where({ team_id: teamId, user_id: userId }).first()
      if (!membership || !roles.includes(membership.role)) {
        res.status(403).json({ error: `Forbidden: requires team role ${roles.join(' or ')}` })
        return
      }
      next()
    } catch {
      res.status(403).json({ error: `Forbidden: requires team role ${roles.join(' or ')}` })
    }
  }
}
