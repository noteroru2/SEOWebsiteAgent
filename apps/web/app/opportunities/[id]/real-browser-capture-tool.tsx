'use client';

import { useEffect, useRef, useState } from 'react';

export function RealBrowserCaptureTool(props: {
  opportunityId: string;
  requestId: string;
  query: string;
}) {
  const [location, setLocation] = useState('Ubon Ratchathani, Thailand');
  const [tool, setTool] = useState<{ bookmarklet: string; expiresAt: string } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const bookmarkRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (tool && bookmarkRef.current) bookmarkRef.current.setAttribute('href', tool.bookmarklet);
  }, [tool]);

  async function createTool() {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/browser-captures/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          opportunityId: props.opportunityId,
          requestId: props.requestId,
          ownerDeclaredLocation: location,
        }),
      });
      const result = (await response.json()) as {
        bookmarklet?: string;
        expiresAt?: string;
        error?: string;
      };
      if (!response.ok || !result.bookmarklet || !result.expiresAt)
        throw new Error(result.error || 'Capture tool could not be created');
      setTool({ bookmarklet: result.bookmarklet, expiresAt: result.expiresAt });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Capture tool could not be created');
    } finally {
      setLoading(false);
    }
  }

  async function copyTool() {
    if (tool) await navigator.clipboard.writeText(tool.bookmarklet);
  }

  return (
    <section className="capture-tool">
      <h3>Real Browser Capture</h3>
      <p className="hint">
        Creates a short-lived, one-use local bookmarklet fixed to “{props.query}” and amphon.co.th.
        It collects no cookies, account data, or browsing history.
      </p>
      <label>
        Owner-declared location
        <input
          value={location}
          maxLength={200}
          onChange={(event) => setLocation(event.target.value)}
        />
      </label>
      <button type="button" onClick={createTool} disabled={loading || !location.trim()}>
        {loading ? 'Creating…' : 'Get Browser Capture Tool'}
      </button>
      {error ? <p className="danger-text">{error}</p> : null}
      {tool ? (
        <div className="notice">
          <p>Drag this link to the Chrome bookmarks bar, or copy it and save it as a bookmark:</p>
          <p>
            <a ref={bookmarkRef}>Capture SERP for SEO Agent</a>{' '}
            <button type="button" onClick={copyTool}>
              Copy bookmarklet
            </button>
          </p>
          <p className="hint">One use · expires {new Date(tool.expiresAt).toLocaleString()}</p>
        </div>
      ) : null}
      <p className="hint">Real mobile assisted capture is not yet supported in V1.1.</p>
    </section>
  );
}
