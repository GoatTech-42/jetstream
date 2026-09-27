// Jetstream addon for Ramjet - your own YouTube frontend, filter-safe by design.
// The client only ever talks to the Ramjet origin: the catalog comes from a
// piped upstream + YouTube's own innertube API server-side, and video bytes +
// thumbnails are re-proxied through /api/jetstream/* so school filters never
// see a google domain. GoatTech, 2026. MIT.
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
// -- response cache -------------------------------------------------------------
const apiCache = new Map();
const API_CACHE_MAX = 160;
async function cached(key, ttlMs, fn) {
	const hit = apiCache.get(key);
	if (hit && Date.now() - hit.ts < ttlMs) return hit.data;
	const data = await fn(); // throws propagate; failures are never cached
	apiCache.set(key, { data, ts: Date.now() });
	if (apiCache.size > API_CACHE_MAX) apiCache.delete(apiCache.keys().next().value);
	return data;
}
async function cachedApi(path, ttlMs) { return cached("piped:" + path, ttlMs, () => api(path)); }
async function api(path) {
	let lastErr = null;
	for (const base of UPSTREAMS) {
		try {
			const r = await fetch(base + path, { headers: { "user-agent": "ramjet-jetstream/1.2", accept: "application/json" }, redirect: "follow", signal: AbortSignal.timeout(12000) });
			if (!r.ok) { lastErr = new Error("upstream " + r.status); continue; }
			return await r.json();
		} catch (e) { lastErr = e; }
	}
	throw lastErr || new Error("no jetstream upstream");
}
function b64(u) { return Buffer.from(String(u), "utf8").toString("base64url"); }
function unb64(s) { try { return Buffer.from(String(s), "base64url").toString("utf8"); } catch { return null; } }
const HOST_OK = /(^|\.)googlevideo\.com$|(^|\.)ytimg\.com$|(^|\.)ggpht\.com$|(^|\.)googleusercontent\.com$|(^|\.)piped\.private\.coffee$|(^|\.)adminforge\.de$|(^|\.)kavin\.rocks$/i;
function proxyHostOK(u) { try { return HOST_OK.test(new URL(u).hostname); } catch { return false; } }
function fmtDur(sec) { sec = Math.max(0, Number(sec) || 0); return Math.floor(sec / 60) + ":" + String(Math.floor(sec) % 60).padStart(2, "0"); }
// mqdefault (320x180) for grid cards - half the bytes of hqdefault, same shape.
function thumbFor(id) { return "/api/jetstream/img?u=" + b64("https://i.ytimg.com/vi/" + id + "/mqdefault.jpg"); }
function item(it) {
	const id = (it.url || "").split("v=").pop();
	const chId = (it.uploaderUrl || "").split("/channel/").pop() || "";
	const secs = Number(it.duration) || 0;
	// piped uses duration -1 for live streams (rendered 0:00 before) - badge them
	const live = it.duration === -1 || it.livestream === true;
	return { id, title: it.title || "", thumb: thumbFor(id), dur: secs > 0 ? fmtDur(secs) : "", uploader: it.uploaderName || it.uploader || "", chId, views: it.views || it.viewCount || 0, live };
}
// live streams can't play through jetstream - drop them from listings, but
// never filter a page down to nothing (saturday trending is mostly live games)
function preferPlayable(items) {
	const playable = items.filter((x) => !x.live);
	return playable.length >= 8 ? playable : items;
}


// when piped instances get bot-checked on /streams, fall back to YouTube's own
// innertube clients - the server can talk to youtube directly; only the CLIENT
// must never see a google domain (that stays true: bytes are re-proxied).
const INNERTUBE_KEYS = (process.env.JETSTREAM_INNERTUBE_KEYS || "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8,AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w").split(",").map((s) => s.trim()).filter(Boolean);
const INNERTUBE_UA = "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip";
const WEB_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
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
// channel + playlist pages come from the WEB innertube browse endpoint.
async function innertubeBrowse(browseId) {
	let lastErr = null;
	for (const key of INNERTUBE_KEYS) {
		try {
			const r = await fetch("https://www.youtube.com/youtubei/v1/browse?key=" + key, {
				method: "POST",
				headers: { "content-type": "application/json", "user-agent": WEB_UA },
				body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: "2.20240926.00.00", hl: "en" } }, browseId }),
				signal: AbortSignal.timeout(15000),
			});
			if (!r.ok) { lastErr = new Error("browse " + r.status); continue; }
			const d = await r.json();
			if (d && d.error) { lastErr = new Error("browse: " + (d.error.message || "error")); continue; }
			return d;
		} catch (e) { lastErr = e; }
	}
	throw lastErr || new Error("browse failed");
}
function walkAll(o, key, out) {
	out = out || [];
	if (!o || typeof o !== "object") return out;
	if (Object.prototype.hasOwnProperty.call(o, key) && o[key] && typeof o[key] === "object") out.push(o[key]);
	for (const k in o) walkAll(o[k], key, out);
	return out;
}
// modern channel/playlist pages carry videos as lockupViewModel nodes
function lockupItem(l) {
	if (!l || l.contentType !== "LOCKUP_CONTENT_TYPE_VIDEO" || !/^[a-zA-Z0-9_-]{11}$/.test(l.contentId || "")) return null;
	const md = l.metadata && l.metadata.lockupMetadataViewModel;
	const title = (md && md.title && md.title.content) || "";
	const rows = (md && md.metadata && md.metadata.contentMetadataViewModel && md.metadata.contentMetadataViewModel.metadataRows) || [];
	const parts = [];
	for (const r of rows) for (const p of r.metadataParts || []) { if (p.text && p.text.content) parts.push(p.text.content); }
	let dur = "";
	for (const b of walkAll(l.contentImage, "thumbnailBadgeViewModel")) { if (/\d+:\d\d/.test(b.text || "")) { dur = b.text; break; } }
	return { id: l.contentId, title, thumb: thumbFor(l.contentId), dur, metaText: parts.join(" · ") };
}
// the WEB "next" endpoint carries likes + the comments section continuation
async function innertubeNext(body) {
	let lastErr = null;
	for (const key of INNERTUBE_KEYS) {
		try {
			const r = await fetch("https://www.youtube.com/youtubei/v1/next?key=" + key, {
				method: "POST",
				headers: { "content-type": "application/json", "user-agent": WEB_UA },
				body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: "2.20240926.00.00", hl: "en" } }, ...body }),
				signal: AbortSignal.timeout(15000),
			});
			if (!r.ok) { lastErr = new Error("next " + r.status); continue; }
			const d = await r.json();
			if (d && d.error) { lastErr = new Error("next: " + (d.error.message || "error")); continue; }
			return d;
		} catch (e) { lastErr = e; }
	}
	throw lastErr || new Error("next failed");
}
function findCommentsToken(d) {
	let token = null;
	(function walk(o) {
		if (token || !o || typeof o !== "object") return;
		if (o.itemSectionRenderer && /comment/i.test(o.itemSectionRenderer.sectionIdentifier || "")) {
			const toks = walkAll(o, "continuationCommand");
			if (toks.length && toks[0].token) { token = toks[0].token; return; }
		}
		for (const k in o) walk(o[k]);
	})(d);
	return token;
}
async function commentsFor(v) {
	const first = await innertubeNext({ videoId: v });
	// video like count lives on the like button's a11y label
	let likes = "";
	try {
		const s = JSON.stringify(walkAll(first, "segmentedLikeDislikeButtonViewModel")[0] || {});
		const m = /along with ([\d,]+(?:\.\d+)?[KMB]?) other/i.exec(s) || /([\d,]+(?:\.\d+)?[KMB]?) likes/i.exec(s);
		if (m) likes = m[1];
	} catch (e) {}
	let count = "";
	const cm = /"([\d,]+) Comments"/.exec(JSON.stringify(first));
	if (cm) count = cm[1];
	const comments = [];
	const token = findCommentsToken(first);
	if (token) {
		const d = await innertubeNext({ continuation: token });
		const byKey = new Map();
		const muts = (d.frameworkUpdates && d.frameworkUpdates.entityBatchUpdate && d.frameworkUpdates.entityBatchUpdate.mutations) || [];
		for (const m of muts) {
			const pl = m.payload && m.payload.commentEntityPayload;
			if (pl) byKey.set(pl.key, pl);
		}
		const seen = new Set();
		const emit = (key, pinned) => {
			const pl = byKey.get(key);
			if (!pl || seen.has(key)) return;
			seen.add(key);
			comments.push({
				author: (pl.author && pl.author.displayName) || "",
				avatar: pl.author && pl.author.avatarThumbnailUrl ? "/api/jetstream/img?u=" + b64(pl.author.avatarThumbnailUrl) : "",
				text: (pl.properties && pl.properties.content && pl.properties.content.content) || "",
				likes: (pl.toolbar && pl.toolbar.likeCountA11y) || "",
				time: (pl.properties && pl.properties.publishedTime) || "",
				pinned: !!pinned,
			});
		};
		for (const t of walkAll(d, "commentThreadRenderer")) {
			const inner = t.commentViewModel && t.commentViewModel.commentViewModel;
			if (inner && inner.commentKey) emit(inner.commentKey, !!inner.pinnedText);
		}
		if (!comments.length) for (const k of byKey.keys()) emit(k, false);
	}
	return { ok: true, count, likes, comments: comments.slice(0, 20) };
}
async function watchViaInnertube(v) {
	const d = await innertube(v);
	const vd = d.videoDetails || {};
	const allFormats = ((d.streamingData && (d.streamingData.formats || []).concat(d.streamingData.adaptiveFormats || [])) || []);
	// vertical video (shorts etc.) - pick a narrow player instead of letterboxing
	let maxW = 0, maxH = 0;
	for (const f of allFormats) { if (f.width && f.height && /video/.test(f.mimeType || "")) { if (f.width > maxW) maxW = f.width; if (f.height > maxH) maxH = f.height; } }
	const vertical = maxH > 0 && maxH > maxW;
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
	return { ok: true, id: v, title: vd.title || "", uploader: vd.author || "", chId: vd.channelId || "", thumb: "/api/jetstream/img?u=" + b64(thumbUrl), dur: fmtDur(vd.lengthSeconds), views: Number(vd.viewCount) || 0, likes: 0, uploaded: "", description: String(vd.shortDescription || "").slice(0, 2000), streams, related, live: !!vd.isLiveContent, vertical };
}

export default async function handle(req, res, route, url, ctx) {
	if (!ctx.user) { json(res, 401, { error: "no session" }); return; }
	try {
		if (route === "trending" && req.method === "GET") {
			const d = await cachedApi("/trending?region=US", 10 * 60 * 1000);
			return json(res, 200, { ok: true, items: preferPlayable((Array.isArray(d) ? d : []).filter((x) => x && x.url).map(item)) }, req);
		}
		if (route === "search" && req.method === "GET") {
			const q = (url.searchParams.get("q") || "").trim();
			if (!q) return json(res, 400, { error: "missing q" });
			const d = await cachedApi("/search?q=" + encodeURIComponent(q) + "&filter=videos", 5 * 60 * 1000);
			const items = (d && Array.isArray(d.items) ? d.items : []).filter((x) => x && x.type === "stream" && x.url).map(item);
			return json(res, 200, { ok: true, items: preferPlayable(items) }, req);
		}
		if (route === "search-playlists" && req.method === "GET") {
			const q = (url.searchParams.get("q") || "").trim();
			if (!q) return json(res, 400, { error: "missing q" });
			const d = await cachedApi("/search?q=" + encodeURIComponent(q) + "&filter=playlists", 5 * 60 * 1000);
			const items = (d && Array.isArray(d.items) ? d.items : []).filter((x) => x && x.type === "playlist" && x.url).slice(0, 6).map((x) => ({
				id: (x.url || "").split("list=").pop(), title: x.name || "", uploader: x.uploaderName || "", count: x.videos || 0,
				thumb: x.thumbnail ? "/api/jetstream/img?u=" + b64(x.thumbnail) : "",
			}));
			return json(res, 200, { ok: true, items }, req);
		}
		if (route === "channel" && req.method === "GET") {
			const id = (url.searchParams.get("id") || "").trim();
			if (!/^[a-zA-Z0-9_-]{20,40}$/.test(id)) return json(res, 400, { error: "bad channel id" });
			const d = await cached("browse:" + id, 10 * 60 * 1000, () => innertubeBrowse(id));
			const meta = walkAll(d, "channelMetadataRenderer")[0] || {};
			const phr = walkAll(d, "pageHeaderRenderer").find((p) => p && p.content && p.content.pageHeaderViewModel);
			const phv = phr ? phr.content.pageHeaderViewModel : null;
			let avatar = "";
			try {
				const sources = phv.image.decoratedAvatarViewModel.avatar.avatarViewModel.image.sources || [];
				if (sources.length) avatar = "/api/jetstream/img?u=" + b64(sources[sources.length - 1].url);
			} catch (e) {}
			const mrows = (phv && phv.metadata && phv.metadata.contentMetadataViewModel && phv.metadata.contentMetadataViewModel.metadataRows) || [];
			const mtexts = [];
			for (const r of mrows) for (const p of r.metadataParts || []) { if (p.text && p.text.content) mtexts.push(p.text.content); }
			const seen = new Set();
			const videos = [];
			for (const l of walkAll(d, "lockupViewModel")) {
				const it = lockupItem(l);
				if (it && !seen.has(it.id)) { seen.add(it.id); videos.push(it); }
			}
			const shorts = [];
			for (const s of walkAll(d, "shortsLockupViewModel")) {
				const m = /shorts-shelf-item-([a-zA-Z0-9_-]{11})/.exec(s.entityId || "");
				if (!m || seen.has(m[1])) continue;
				seen.add(m[1]);
				const t = String(s.accessibilityText || "").replace(/, [\d.,]+ ?[a-z]* views? - play Short.*$/i, "");
				shorts.push({ id: m[1], title: t, short: true, thumb: thumbFor(m[1]) });
			}
			return json(res, 200, { ok: true, id, name: meta.title || (phv && phv.title && phv.title.dynamicTextViewModel && phv.title.dynamicTextViewModel.text && phv.title.dynamicTextViewModel.text.content) || "", description: String(meta.description || "").slice(0, 600), subs: mtexts.join(" · "), avatar, videos: videos.slice(0, 30), shorts: shorts.slice(0, 20) }, req);
		}
		if (route === "playlist" && req.method === "GET") {
			const id = (url.searchParams.get("id") || "").trim();
			if (!/^[a-zA-Z0-9_-]{10,80}$/.test(id)) return json(res, 400, { error: "bad playlist id" });
			const d = await cached("browse:VL" + id, 10 * 60 * 1000, () => innertubeBrowse("VL" + id));
			const pm = walkAll(d, "playlistMetadataRenderer")[0] || {};
			const seen = new Set();
			const videos = [];
			for (const l of walkAll(d, "lockupViewModel")) {
				const it = lockupItem(l);
				if (it && !seen.has(it.id)) { seen.add(it.id); videos.push(it); }
			}
			return json(res, 200, { ok: true, id, title: pm.title || "playlist", videos: videos.slice(0, 100) }, req);
		}
		if (route === "watch" && req.method === "GET") {
			const v = (url.searchParams.get("v") || "").trim();
			if (!/^[a-zA-Z0-9_-]{11}$/.test(v)) return json(res, 400, { error: "bad video id" });
			try {
				return json(res, 200, await cached("watch:" + v, 5 * 60 * 1000, () => watchViaInnertube(v)), req);
			} catch (e) {}
			const d = await cachedApi("/streams/" + v, 5 * 60 * 1000);
			const streams = (d.videoStreams || [])
				.filter((s) => s && s.url && s.videoOnly === false && /\d+p/.test(s.quality || ""))
				.sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0))
				.slice(0, 3)
				.map((s) => ({ q: s.quality, src: "/api/jetstream/stream?u=" + b64(s.url) }));
			const related = (d.relatedStreams || []).filter((x) => x && x.url).slice(0, 18).map(item);
			return json(res, 200, { ok: true, id: v, title: d.title || "", uploader: d.uploader || "", thumb: "/api/jetstream/img?u=" + b64(d.thumbnailUrl || ""), dur: fmtDur(d.duration), views: d.views || 0, likes: d.likes || 0, uploaded: d.uploadDate || "", description: String(d.description || "").slice(0, 2000), streams, related, live: !!d.livestream, vertical: false });
		}
		if (route === "comments" && req.method === "GET") {
			const v = (url.searchParams.get("v") || "").trim();
			if (!/^[a-zA-Z0-9_-]{11}$/.test(v)) return json(res, 400, { error: "bad video id" });
			return json(res, 200, await cached("comments:" + v, 10 * 60 * 1000, () => commentsFor(v)), req);
		}
		if ((route === "stream" || route === "img") && req.method === "GET") {
			const u = unb64(url.searchParams.get("u") || "");
			if (!u || !proxyHostOK(u)) return json(res, 400, { error: "bad url" });
			const headers = { "user-agent": "ramjet-jetstream/1.2" };
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
