import { serpProviderStatus } from '@seo-agent/database';
import { configureSerpProviderAction } from '../actions';

export const dynamic = 'force-dynamic';

export default async function SerpProvidersPage() {
  const providers = await serpProviderStatus();
  return (
    <>
      <div className="heading">
        <div>
          <div className="eyebrow">Evidence automation</div>
          <h1>SERP Providers</h1>
          <p className="muted">Internal free-only safety limits; not provider account balances.</p>
        </div>
      </div>
      {providers.map((provider) => (
        <section className="panel section" key={provider.provider}>
          <h2>{provider.provider}</h2>
          <div className="grid">
            <p>
              <strong>Enabled:</strong> {provider.enabled ? 'YES' : 'NO'}
            </p>
            <p>
              <strong>Credential configured:</strong>{' '}
              {provider.credential_configured ? 'YES' : 'NO'}
            </p>
            <p>
              <strong>Mode:</strong> FREE_ONLY
            </p>
            <p>
              <strong>Health:</strong> {provider.effective_health}
            </p>
            <p>
              <strong>Internal allowance:</strong> {provider.period_allowance ?? 'NOT INITIALIZED'}
            </p>
            <p>
              <strong>Used:</strong> {provider.used}
            </p>
            <p>
              <strong>Reserved:</strong> {provider.reserved}
            </p>
            <p>
              <strong>Remaining:</strong> {provider.remaining}
            </p>
            <p>
              <strong>Period:</strong>{' '}
              {provider.period_start
                ? `${new Date(provider.period_start).toLocaleString()} → ${provider.period_end ? new Date(provider.period_end).toLocaleString() : 'no automatic reset'}`
                : 'Owner initialization required'}
            </p>
            <p>
              <strong>Last success:</strong>{' '}
              {provider.last_success_at ? new Date(provider.last_success_at).toLocaleString() : '—'}
            </p>
            <p>
              <strong>Last failure:</strong>{' '}
              {provider.last_failure_at ? new Date(provider.last_failure_at).toLocaleString() : '—'}
            </p>
            <p>
              <strong>Last error:</strong> {provider.last_error_category ?? '—'}
            </p>
          </div>
          <details>
            <summary>Owner configuration</summary>
            <form action={configureSerpProviderAction}>
              <input type="hidden" name="provider" value={provider.provider} />
              <label>
                <input type="checkbox" name="enabled" defaultChecked={provider.enabled} /> Enabled
              </label>
              <label>
                Internal free allowance
                <input
                  name="configuredAllowance"
                  type="number"
                  min="0"
                  defaultValue={provider.configured_allowance}
                  required
                />
              </label>
              <label>
                Period start
                <input name="periodStart" type="datetime-local" required />
              </label>
              <label>
                Period end (blank for credit pool / explicit reset)
                <input name="periodEnd" type="datetime-local" />
              </label>
              <button>Confirm Free Allowance</button>
            </form>
          </details>
        </section>
      ))}
    </>
  );
}
