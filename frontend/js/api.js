async function jfetch(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) {
    let msg = `Request failed (${r.status})`;
    try {
      const body = await r.json();
      if (body.detail) msg = typeof body.detail === "string" ? body.detail : msg;
    } catch (_) { /* keep default */ }
    throw new Error(msg);
  }
  return r.json();
}

export function geocode(q) {
  return jfetch(`/api/geocode?q=${encodeURIComponent(q)}`);
}

export function search(payload) {
  return jfetch("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function finalize(payload) {
  return jfetch("/api/finalize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}
