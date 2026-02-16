/**
 * Cloudflare Worker for Sift Proxy
 * Handles standard CORS proxying and batch fetching for RSS.
 */

// Helper to add CORS headers
function addCorsHeaders(headers) {
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Range, Git-Protocol, User-Agent, If-None-Match, If-Modified-Since, Cache-Control, Pragma');
  headers.set('Access-Control-Expose-Headers', '*');
  headers.set('Access-Control-Max-Age', '86400');
}

// Handle OPTIONS (Preflight)
function handleOptions(request) {
  const headers = new Headers();
  addCorsHeaders(headers);
  return new Response(null, { status: 204, headers });
}

async function handleBatch(request) {
  try {
    const body = await request.json();
    const { urls } = body;

    if (!urls || !Array.isArray(urls)) {
      const headers = new Headers();
      addCorsHeaders(headers);
      return new Response('Invalid Request: "urls" must be an array', { status: 400, headers });
    }

    // Limit concurrency to avoid overloading
    const results = await Promise.all(urls.map(async (url) => {
      try {
        const headers = {
          'Accept': 'application/rss+xml, application/xml, text/xml, application/atom+xml, text/html, */*'
        };

        // Pass through User-Agent if present in the batch request
        if (request.headers.has('User-Agent')) {
          headers['User-Agent'] = request.headers.get('User-Agent');
        } else {
          headers['User-Agent'] = 'Sift-RSS-Fetcher/1.0';
        }

        const res = await fetch(url, {
          method: 'GET',
          headers,
          redirect: 'follow'
        });

        if (!res.ok) {
          return { url, ok: false, status: res.status, error: res.statusText };
        }

        const content = await res.text();
        return {
          url,
          ok: true,
          status: res.status,
          content,
          headers: Object.fromEntries(res.headers.entries())
        };

      } catch (e) {
        return { url, ok: false, status: 500, error: e.message };
      }
    }));

    const response = new Response(JSON.stringify({ results }), {
      headers: { 'Content-Type': 'application/json' }
    });
    addCorsHeaders(response.headers);
    return response;

  } catch (e) {
    const headers = new Headers();
    addCorsHeaders(headers);
    return new Response(`Batch Error: ${e.message}`, { status: 500, headers });
  }
}

async function handleProxy(request) {
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url');

  if (!targetUrl) {
    const headers = new Headers();
    addCorsHeaders(headers);
    return new Response('Missing "url" parameter', { status: 400, headers });
  }

  // Sanitize URL: isomorphic-git sometimes strips the protocol or sends it as a path
  // e.g. "github.com/Start" or "/github.com/..."
  let finalTargetUrl = targetUrl;

  // Remove leading slash if present (common artifacts from some clients)
  if (finalTargetUrl.startsWith('/')) {
    finalTargetUrl = finalTargetUrl.substring(1);
  }

  if (!finalTargetUrl.startsWith('http://') && !finalTargetUrl.startsWith('https://')) {
    // Default to HTTPS if protocol is missing
    finalTargetUrl = 'https://' + finalTargetUrl;
  }

  // Clone original request to preserve headers (especially Authorization for Git)
  const originalHeaders = new Headers(request.headers);

  // Clean up headers that might cause issues or expose proxy details
  originalHeaders.delete('Host');
  originalHeaders.delete('Referer');
  originalHeaders.delete('Origin');
  originalHeaders.delete('cf-connecting-ip');
  originalHeaders.delete('x-forwarded-for');
  originalHeaders.delete('x-real-ip');

  // Some cloud providers block requests without a User-Agent
  if (!originalHeaders.has('User-Agent')) {
    originalHeaders.set('User-Agent', 'Sift-Proxy/1.0');
  }

  try {
    // For POST requests (like git-receive-pack), we need to forward the body.
    // Cloudflare Workers handle body streaming automatically if we pass request.body,
    // but typically modifying the request requires reading the body.
    // Here we construct a new Request.

    const fetchOptions = {
      method: request.method,
      headers: originalHeaders,
      redirect: 'follow'
    };

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      fetchOptions.body = request.body;
    }

    const response = await fetch(finalTargetUrl, fetchOptions);

    const newHeaders = new Headers(response.headers);
    addCorsHeaders(newHeaders);

    // Clean up headers
    newHeaders.delete('X-Frame-Options');
    newHeaders.delete('Content-Security-Policy');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders
    });

  } catch (e) {
    const headers = new Headers();
    addCorsHeaders(headers);
    return new Response(`Proxy Error: ${e.message}`, { status: 502, headers });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return handleOptions(request);
    }

    if (url.pathname === '/batch' && request.method === 'POST') {
      return handleBatch(request);
    }

    // Default: Proxy
    return handleProxy(request);
  }
};
