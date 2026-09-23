import { Hono } from 'hono'
import { getContentMigrationStatus } from '../services/content-migration-service.js'

/** Hono sub-router exposing `GET /status` for the runtime content migration. */
export const migrationRouter = new Hono()

migrationRouter.get('/status', (c) => c.json(getContentMigrationStatus()))
