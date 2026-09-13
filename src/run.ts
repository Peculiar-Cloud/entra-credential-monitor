#!/usr/bin/env node

/**
 * Monitoring runner for GitHub-compatible Actions.
 * Scans multiple Entra ID tenants and sends a per-tenant email report.
 *
 * The orchestration lives in `main(env, deps)`, which is dependency-injected
 * and returns an exit code rather than calling process.exit, so it can be
 * tested. The module-level block at the bottom only runs when this file is the
 * process entry point.
 */

import { sendErrorNotification, sendMonitoringReport } from './email/email-service.js'
import { escapeHtml } from './email/templates/escape.js'
import { hasAnyIssues } from './email/templates/index.js'
import { actions } from './github-actions.js'
import { GraphClient } from './graph-client.js'
import { HealthchecksClient } from './healthchecks-client.js'
import { consoleLogger, createLogger, type Logger } from './logger.js'
import { AppRegistrationMonitor } from './monitor/index.js'
import {
  type EnvConfig,
  type Findings,
  loadEnv,
  parseTenantConfigs,
  type TenantConfig,
} from './schemas.js'

interface TenantError {
  tenant: TenantConfig
  error: Error
}

interface TenantResult {
  tenant: TenantConfig
  findings: Findings
  emailSent: boolean
}

interface MonitoringResult {
  results: TenantResult[]
  totalTenants: number
  warningDays: number
}

/**
 * Minimal healthchecks.io surface used by the runner (injectable for tests).
 */
export interface HealthchecksLike {
  start(): Promise<void>
  success(): Promise<void>
  fail(error: Error | null): Promise<void>
}

/**
 * Dependencies injected into `main`. Production wiring is in
 * `buildProductionDeps`; tests pass fakes.
 */
export interface RunDeps {
  getTenants: () => TenantConfig[]
  scanTenant: (tenant: TenantConfig, env: EnvConfig) => Promise<Findings>
  sendReport: (env: EnvConfig, findings: Findings) => Promise<boolean>
  sendErrorNotification: (
    env: EnvConfig,
    subject: string,
    html: string,
    text: string,
  ) => Promise<boolean>
  healthchecks: HealthchecksLike
  logger?: Logger
}

type AggregateError = Error & { emailError?: boolean }

/**
 * Parse tenant configurations from environment variables.
 *
 * Supports two formats:
 *   1. JSON array via ENTRA_TENANTS.
 *   2. Single tenant via ENTRA_TENANT_ID / ENTRA_CLIENT_ID / ENTRA_CLIENT_SECRET.
 */
export function getTenantConfigs(): TenantConfig[] {
  return parseTenantConfigs({
    ENTRA_TENANTS: process.env.ENTRA_TENANTS,
    ENTRA_TENANT_ID: process.env.ENTRA_TENANT_ID,
    ENTRA_CLIENT_ID: process.env.ENTRA_CLIENT_ID,
    ENTRA_CLIENT_SECRET: process.env.ENTRA_CLIENT_SECRET,
    ENTRA_TENANT_NAME: process.env.ENTRA_TENANT_NAME,
  })
}

function logTenantResult(tenant: TenantConfig, findings: Findings, logger: Logger): void {
  const hasExpired = findings.expiredSecrets.length > 0 || findings.expiredCertificates.length > 0
  const hasExpiring =
    findings.expiringSecrets.length > 0 || findings.expiringCertificates.length > 0

  logger.info('Results:')
  logger.info(`  Expired secrets:       ${findings.expiredSecrets.length}`)
  logger.info(`  Expiring secrets:      ${findings.expiringSecrets.length}`)
  logger.info(`  Expired certificates:  ${findings.expiredCertificates.length}`)
  logger.info(`  Expiring certificates: ${findings.expiringCertificates.length}`)

  if (hasExpired) {
    actions.error(
      `${findings.expiredSecrets.length + findings.expiredCertificates.length} expired credential(s) found`,
      tenant.name,
    )
  } else if (hasExpiring) {
    actions.warning(
      `${findings.expiringSecrets.length + findings.expiringCertificates.length} expiring credential(s) found`,
      tenant.name,
    )
  } else {
    actions.notice('All credentials healthy', tenant.name)
  }
}

/**
 * Orchestrate a full monitoring run. Returns the process exit code.
 */
export async function main(env: EnvConfig, deps: RunDeps): Promise<number> {
  const logger = deps.logger ?? consoleLogger

  logger.info(`[${new Date().toISOString()}] Starting scheduled monitoring run...`)

  await deps.healthchecks.start().catch((err: Error) => {
    logger.warn({ err }, 'Failed to send start ping to healthchecks.io')
  })

  actions.startGroup('Initializing')
  const tenants = deps.getTenants()

  if (tenants.length === 0) {
    actions.endGroup()
    const err = new Error(
      'No tenant configurations found. Set ENTRA_TENANTS JSON array or ENTRA_TENANT_ID/CLIENT_ID/CLIENT_SECRET',
    )
    return failRun(env, deps, err, logger)
  }

  logger.info(`Tenants configured: ${tenants.length}`)
  actions.endGroup()

  const results: TenantResult[] = []
  const errors: TenantError[] = []

  for (const tenant of tenants) {
    actions.startGroup(`Scanning: ${tenant.name}`)
    try {
      const tenantEnv: EnvConfig = { ...env, ENTRA_CLIENT_ID: tenant.clientId }
      const findings = await deps.scanTenant(tenant, tenantEnv)
      logTenantResult(tenant, findings, logger)

      const emailSent = await deps.sendReport(tenantEnv, findings)
      if (emailSent) {
        const orgName = findings.organizationInfo?.displayName || tenant.name
        actions.notice(`Email report sent for ${orgName}`)
      }
      results.push({ tenant, findings, emailSent })
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      actions.error(`Failed to process: ${err.message}`, tenant.name)
      errors.push({ tenant, error: err })
    } finally {
      actions.endGroup()
    }
  }

  printSummary(results, errors, tenants.length, logger)

  if (errors.length > 0) {
    const isEmailError = errors.some((e) => (e.error as AggregateError).emailError)
    const err: AggregateError = new Error(`${errors.length} tenant(s) failed to process`)
    err.emailError = isEmailError
    return failRun(env, deps, err, logger)
  }

  logger.info(`\n[${new Date().toISOString()}] Monitoring completed successfully`)
  actions.writeSummary(
    generateActionsSummaryFromResults({ results, totalTenants: tenants.length, warningDays: 0 }),
  )

  await deps.healthchecks.success().catch((err: Error) => {
    logger.warn({ err }, 'Failed to send success ping to healthchecks.io')
  })

  return 0
}

/**
 * Handle the failure path: log, write the error summary, optionally email an
 * error notification (unless the failure itself was an email failure), and ping
 * healthchecks.io. Returns exit code 1.
 */
async function failRun(
  env: EnvConfig,
  deps: RunDeps,
  error: AggregateError,
  logger: Logger,
): Promise<number> {
  logger.error({ err: error }, 'Monitoring failed')
  actions.error(error.message, 'Monitoring Failed')

  actions.writeSummary(`# 🔴 Monitoring Failed

**Error:** ${error.message}

Check the workflow logs for more details.

---

<sub>Generated by [Entra Credential Monitor](https://github.com/Peculiar-Cloud/entra-credential-monitor)</sub>
`)

  if (!error.emailError) {
    try {
      await deps.sendErrorNotification(
        env,
        'Entra ID Monitoring Error',
        `<div style="font-family: Arial, sans-serif;">
            <h2 style="color: #dc3545;">Monitoring Error</h2>
            <p>The Entra ID app registration monitoring encountered an error:</p>
            <pre style="background: #f8f9fa; padding: 15px; border-radius: 5px;">${escapeHtml(error.message)}</pre>
          </div>`,
        `Entra ID Monitoring Error\n\nThe monitoring service encountered an error:\n\n${error.message}`,
      )
    } catch (emailError) {
      const err = emailError instanceof Error ? emailError : new Error(String(emailError))
      logger.error({ err }, 'Failed to send error notification')
    }
  }

  await deps.healthchecks.fail(error).catch((err: Error) => {
    logger.warn({ err }, 'Failed to send failure ping to healthchecks.io')
  })

  return 1
}

function printSummary(
  results: TenantResult[],
  errors: TenantError[],
  totalTenants: number,
  logger: Logger,
): void {
  actions.startGroup('Summary')
  logger.info(`Tenants processed: ${results.length}/${totalTenants}`)

  let totalExpired = 0
  let totalExpiring = 0
  let totalEmailsSent = 0

  for (const { tenant, findings, emailSent } of results) {
    const expired = findings.expiredSecrets.length + findings.expiredCertificates.length
    const expiring = findings.expiringSecrets.length + findings.expiringCertificates.length
    totalExpired += expired
    totalExpiring += expiring
    if (emailSent) totalEmailsSent++

    const orgName = findings.organizationInfo?.displayName || tenant.name
    logger.info(
      `  ${orgName}: ${expired} expired, ${expiring} expiring${emailSent ? ' (email sent)' : ''}`,
    )
  }

  logger.info(`\nTotal expired credentials: ${totalExpired}`)
  logger.info(`Total expiring credentials: ${totalExpiring}`)
  logger.info(`Emails sent: ${totalEmailsSent}`)

  if (errors.length > 0) {
    logger.info(`\nErrors encountered: ${errors.length}`)
    for (const { tenant, error } of errors) {
      logger.info(`  - ${tenant.name}: ${error.message}`)
    }
  }
  actions.endGroup()
}

/**
 * Wire up production dependencies: real Graph client per tenant, the email
 * service (gated on whether there is anything worth sending), and
 * healthchecks.io.
 */
export function buildProductionDeps(env: EnvConfig): RunDeps {
  const logger = createLogger(env.LOG_LEVEL)
  const healthchecks = new HealthchecksClient(env.HEALTHCHECKS_PING_URL, logger)

  return {
    getTenants: getTenantConfigs,
    scanTenant: async (tenant, tenantEnv) => {
      const graphClient = new GraphClient(
        tenant.tenantId,
        tenant.clientId,
        tenant.clientSecret,
        undefined,
        logger,
      )
      const monitor = new AppRegistrationMonitor(graphClient, env.WARNING_DAYS, logger)
      logger.info('Authenticating with Microsoft Graph API...')
      return monitor.scanApplications(tenantEnv)
    },
    sendReport: async (tenantEnv, findings) => {
      if (!hasAnyIssues(findings) && !tenantEnv.ALWAYS_SEND_REPORT) {
        actions.notice('No issues found - skipping email (ALWAYS_SEND_REPORT=false)')
        return false
      }
      return sendMonitoringReport(tenantEnv, findings, logger)
    },
    sendErrorNotification: (errEnv, subject, html, text) =>
      sendErrorNotification(errEnv, subject, html, text, logger),
    healthchecks: {
      start: () => healthchecks.start(),
      success: () => healthchecks.success(),
      fail: (error) => healthchecks.fail(error),
    },
    logger,
  }
}

/**
 * Generate the Actions step summary from per-tenant results.
 */
export function generateActionsSummaryFromResults(result: MonitoringResult): string {
  const { results, totalTenants } = result

  let totalExpired = 0
  let totalExpiring = 0
  let totalEmailsSent = 0

  for (const { findings, emailSent } of results) {
    totalExpired += findings.expiredSecrets.length + findings.expiredCertificates.length
    totalExpiring += findings.expiringSecrets.length + findings.expiringCertificates.length
    if (emailSent) totalEmailsSent++
  }

  const hasIssues = totalExpired > 0 || totalExpiring > 0
  const icon = totalExpired > 0 ? '🔴' : totalExpiring > 0 ? '🟡' : '🟢'

  let summary = `# ${icon} Entra ID Security Report

| Metric | Value |
|--------|-------|
| Tenants Scanned | ${results.length}/${totalTenants} |
| Total Expired | ${totalExpired} |
| Total Expiring | ${totalExpiring} |
| Emails Sent | ${totalEmailsSent} |

## Per-Tenant Results

`

  for (const { tenant, findings, emailSent } of results) {
    const orgName = findings.organizationInfo?.displayName || tenant.name
    const expired = findings.expiredSecrets.length + findings.expiredCertificates.length
    const expiring = findings.expiringSecrets.length + findings.expiringCertificates.length
    const status = expired > 0 ? '🔴' : expiring > 0 ? '🟡' : '🟢'

    summary += `### ${status} ${orgName}

- Expired: ${expired}
- Expiring: ${expiring}
- Email: ${emailSent ? '✅ Sent' : '—'}

`
  }

  if (!hasIssues) {
    summary += `
> ✅ All credentials are healthy across all tenants!
`
  }

  summary += `
---

<sub>Generated by [Entra Credential Monitor](https://github.com/Peculiar-Cloud/entra-credential-monitor)</sub>
`

  return summary
}

// Module entry point: only execute when run directly, not when imported by tests.
const isEntry = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`
if (isEntry) {
  const env = loadEnv()
  main(env, buildProductionDeps(env)).then((code) => {
    process.exitCode = code
  })
}
