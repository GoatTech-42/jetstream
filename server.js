// Jetstream addon for Ramjet - your own YouTube frontend, filter-safe by design.
// The client only ever talks to the Ramjet origin: the catalog comes from a
// piped upstream server-side, and video bytes + thumbnails are re-proxied
// through /api/jetstream/* so school filters never see a google domain.
// GoatTech, 2026. MIT.
const UPSTREAMS = (process.env.JETSTREAM_UPSTREAMS || process.env.RAMJET_TUBE_UPSTREAMS || "https://api.piped.private.coffee,https://pipedapi.adminforge.de,https://pipedapi.kavin.rocks").split(",").map((s) => s.trim()).filter(Boolean);

async function json(res, code, obj, req) {
	const body = Buffer.from(JSON.stringify(obj), "utf8");
	if (req && body.length > 1024 && String(req.headers["accept-encoding"] || "").includes("gzip")) {
		const { gzipSync } = await import("node:zlib");
		res.writeHead(code, { "content-type": "application/json", "content-encoding": "gzip", vary: "accept-encoding" });
		return res.end(gzipSync(body));
	}
	res.writeHead(code, { "content-type": "application/json" });
	res.end(body);
}
const apiCache = new Map();
const API_CACHE_MAX = 120;
async function cachedApi(path, ttlMs) {
	const hit = apiCache.get(path);
	if (hit && Date.now() - hit.ts < ttlMs) return hit.data;
	const data = await api(path);
	apiCache.set(path, { data, ts: Date.now() });
	if (apiCache.size > API_CACHE_MAX) apiCache.delete(apiCache.keys().next().value);
	return data;
}
async function api(path) {
	let lastErr = null;
	for (const base of UPSTREAMS) {
		try {
			const r = await fetch(base + path, { headers: { "user-agent": "ramjet-jetstream/1.1", accept: "application/json" }, redirect: "follow", signal: AbortSignal.timeout(12000) });
			if (!r.ok) { lastErr = new Error("upstream " + r.status); continue; }
			return await r.json();
		} catch (e) { lastErr = e; }
	}
	throw lastErr || new Error("no jetstream upstream");
}
function b64(u) { return Buffer.from(String(u), "utf8").toString("base64url"); }
function unb64(s) { try { return Buffer.from(String(s), "base64url").toString("utf8"); } catch { return null; } }
const HOST_OK = /(^|\.)googlevideo\.com$|(^|\.)ytimg\.com$|(^|\.)ggpht\.com$|(^|\.)piped\.private\.coffee$|(^|\.)adminforge\.de$|(^|\.)kavin\.rocks$/i;
function proxyHostOK(u) { try { return HOST_OK.test(new URL(u).hostname); } catch { return false; } }
function fmtDur(sec) { sec = Math.max(0, Number(sec) || 0); return Math.floor(sec / 60) + ":" + String(Math.floor(sec) % 60).padStart(2, "0"); }
function item(it) {
	const id = (it.url || "").split("v=").pop();
	const chId = (it.uploaderUrl || "").split("/channel/").pop() || "";
	return { id, title: it.title || "", thumb: "/api/jetstream/img?u=" + b64(it.thumbnail || ""), dur: fmtDur(it.duration), uploader: it.uploaderName || it.uploader || "", chId, views: it.views || it.viewCount || 0 };
}


// when piped instances get bot-checked on /streams, fall back to YouTube's own
// innertube ANDROID client - the server can talk to youtube directly; only the
// CLIENT must never see a google domain (that stays true: bytes are re-proxied).
const INNERTUBE_KEYS = (process.env.JETSTREAM_INNERTUBE_KEYS || "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8,AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w").split(",").map((s) => s.trim()).filter(Boolean);
const INNERTUBE_UA = "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip";
async function innertube(videoId) {
	let lastErr = null;
	for (const key of INNERTUBE_KEYS) {
		try {
			const r = await fetch("https://www.youtube.com/youtubei/v1/player?key=" + key, {
				method: "POST",
				headers: { "content-type": "application/json", "user-agent": INNERTUBE_UA },
				body: JSON.stringify({ context: { client: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30, hl: "en" } }, videoId }),
				signal: AbortSignal.timeout(12000),
			});
			if (!r.ok) { lastErr = new Error("innertube " + r.status); continue; }
			const d = await r.json();
			if (d.playabilityStatus && d.playabilityStatus.status !== "OK") { lastErr = new Error("unplayable: " + d.playabilityStatus.status); continue; }
			return d;
		} catch (e) { lastErr = e; }
	}
	throw lastErr || new Error("innertube failed");
}
async function watchViaInnertube(v) {
	const d = await innertube(v);
	const vd = d.videoDetails || {};
	const streams = ((d.streamingData && d.streamingData.formats) || [])
		.filter((s) => s && s.url && /video\/mp4/.test(s.mimeType || "") && /\d+p/.test(s.qualityLabel || ""))
		.sort((a, b) => (b.height || 0) - (a.height || 0))
		.slice(0, 3)
		.map((s) => ({ q: s.qualityLabel, src: "/api/jetstream/stream?u=" + b64(s.url) }));
	// hqdefault always exists (maxres 404s on plenty of videos)
	const thumbUrl = "https://i.ytimg.com/vi/" + v + "/hqdefault.jpg";
	// best-effort related via piped search on the uploader; fine if it fails
	let related = [];
	try {
		const d2 = await api("/search?q=" + encodeURIComponent(vd.author || "") + "&filter=videos");
		related = (d2 && Array.isArray(d2.items) ? d2.items : []).filter((x) => x && x.type === "stream" && x.url && !x.url.includes(v)).slice(0, 18).map(item);
	} catch (e) {}
	return { ok: true, id: v, title: vd.title || "", uploader: vd.author || "", chId: vd.channelId || "", thumb: "/api/jetstream/img?u=" + b64(thumbUrl), dur: fmtDur(vd.lengthSeconds), views: Number(vd.viewCount) || 0, likes: 0, uploaded: "", description: String(vd.shortDescription || "").slice(0, 2000), streams, related, live: !!vd.isLiveContent };
}

export default async function handle(req, res, route, url, ctx) {
	if (!ctx.user) { json(res, 401, { error: "no session" }); return; }
	try {
		if (route === "trending" && req.method === "GET") {
			const d = await cachedApi("/trending?region=US", 10 * 60 * 1000);
			return json(res, 200, { ok: true, items: (Array.isArray(d) ? d : []).filter((x) => x && x.url).map(item) }, req);
		}
		if (route === "search" && req.method === "GET") {
			const q = (url.searchParams.get("q") || "").trim();
			if (!q) return json(res, 400, { error: "missing q" });
			const d = await cachedApi("/search?q=" + encodeURIComponent(q) + "&filter=videos", 5 * 60 * 1000);
			const items = (d && Array.isArray(d.items) ? d.items : []).filter((x) => x && x.type === "stream" && x.url).map(item);
			return json(res, 200, { ok: true, items }, req);
		}
		if (route === "watch" && req.method === "GET") {
			const v = (url.searchParams.get("v") || "").trim();
			if (!/^[a-zA-Z0-9_-]{11}$/.test(v)) return json(res, 400, { error: "bad video id" });
			try {
				return json(res, 200, await watchViaInnertube(v), req);
			} catch (e) {}
			const d = await api("/streams/" + v);
			const streams = (d.videoStreams || [])
				.filter((s) => s && s.url && s.videoOnly === false && /\d+p/.test(s.quality || ""))
				.sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0))
				.slice(0, 3)
				.map((s) => ({ q: s.quality, src: "/api/jetstream/stream?u=" + b64(s.url) }));
			const related = (d.relatedStreams || []).filter((x) => x && x.url).slice(0, 18).map(item);
			return json(res, 200, { ok: true, id: v, title: d.title || "", uploader: d.uploader || "", thumb: "/api/jetstream/img?u=" + b64(d.thumbnailUrl || ""), dur: fmtDur(d.duration), views: d.views || 0, likes: d.likes || 0, uploaded: d.uploadDate || "", description: String(d.description || "").slice(0, 2000), streams, related, live: !!d.livestream });
		}
		if ((route === "stream" || route === "img") && req.method === "GET") {
			const u = unb64(url.searchParams.get("u") || "");
			if (!u || !proxyHostOK(u)) return json(res, 400, { error: "bad url" });
			const headers = { "user-agent": "ramjet-jetstream/1.1" };
			if (route === "stream" && req.headers.range) headers.range = req.headers.range;
			const r = await fetch(u, { headers, redirect: "follow", signal: AbortSignal.timeout(30000) });
			const h = { "cache-control": route === "img" ? "public, max-age=86400" : "private, no-store" };
			for (const k of ["content-type", "content-length", "content-range", "accept-ranges"]) {
				const val = r.headers.get(k);
				if (val) h[k] = val;
			}
			if (!h["content-type"]) h["content-type"] = route === "img" ? "image/jpeg" : "video/mp4";
			res.writeHead(r.status === 206 ? 206 : r.ok ? 200 : (r.status || 502), h);
			if (!r.body) return res.end();
			for await (const chunk of r.body) {
				if (!res.write(chunk)) await new Promise((d2) => res.once("drain", d2));
			}
			return res.end();
		}
		return json(res, 404, { error: "unknown jetstream route" });
	} catch (e) {
		return json(res, 502, { error: "jetstream upstream failed" });
	}
}
