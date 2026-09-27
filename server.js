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
// soundcloud public client_id, scraped like every proxy music site does it -
// cached in-process; re-scraped when a call starts 403ing (id rotation).
let scCid = "", scCidAt = 0;
async function scClientId(force = false) {
	if (!force && scCid && Date.now() - scCidAt < 6 * 3600e3) return scCid;
	const html = await (await fetch("https://soundcloud.com/", { headers: { "user-agent": WEB_UA }, signal: AbortSignal.timeout(12000) })).text();
	const srcs = [...html.matchAll(/<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/[^"]+\.js)"/g)].map((m) => m[1]);
	for (const src of srcs.reverse()) {
		try {
			const js = await (await fetch(src, { headers: { "user-agent": WEB_UA }, signal: AbortSignal.timeout(12000) })).text();
			const m = /client_id\s*[:=]\s*"([a-zA-Z0-9]{32})"/.exec(js) || /client_id\s*[:=]\s*"([a-zA-Z0-9]{24,40})"/.exec(js);
			if (m) { scCid = m[1]; scCidAt = Date.now(); return scCid; }
		} catch (e) {}
	}
	if (scCid) return scCid;
	throw new Error("no soundcloud client_id");
}
const HOST_OK = /(^|\.)googlevideo\.com$|(^|\.)youtube\.com$|(^|\.)ytimg\.com$|(^|\.)ggpht\.com$|(^|\.)googleusercontent\.com$|(^|\.)sndcdn\.com$|(^|\.)soundcloud\.com$|(^|\.)piped\.private\.coffee$|(^|\.)adminforge\.de$|(^|\.)kavin\.rocks$/i;
function proxyHostOK(u) { try { return HOST_OK.test(new URL(u).hostname); } catch { return false; } }
function fmtDur(sec) { sec = Math.max(0, Number(sec) || 0); return Math.floor(sec / 60) + ":" + String(Math.floor(sec) % 60).padStart(2, "0"); }
// mqdefault (320x180) for grid cards - half the bytes of hqdefault, same shape.
function thumbFor(id) { return "/api/jetstream/img?u=" + b64("https://i.ytimg.com/vi/" + id + "/mqdefault.jpg"); }
function item(it, liveByDuration = true) {
	const id = (it.url || "").split("v=").pop();
	const chId = (it.uploaderUrl || "").split("/channel/").pop() || "";
	const secs = Number(it.duration) || 0;
	// piped uses duration -1 for live streams (rendered 0:00 before) - badge them
	// liveByDuration=false when the upstream's extractor is broken and returns -1 on
	// everything (Sep 26 incident): then only the explicit flag marks live, so a
	// broken parser can't blank the whole feed.
	// uploaded<0 is the duration-independent live signal (Luke 9/26: lives still
	// leaking): piped stamps live/premiere items uploaded:-1 even while the
	// extractor breakage zeroes every duration - verified against live upstream.
	const live = it.livestream === true || it.uploaded < 0 || (liveByDuration && it.duration === -1);
	return { id, title: it.title || "", thumb: thumbFor(id), dur: secs > 0 ? fmtDur(secs) : "", uploader: it.uploaderName || it.uploader || "", chId, views: it.views || it.viewCount || 0, live };
}
// live streams can't play through jetstream - hide them everywhere (Luke's call, v1.6)
function preferPlayable(items) {
	return items.filter((x) => !x.live);
}


// when piped instances get bot-checked on /streams, fall back to YouTube's own
// innertube clients - the server can talk to youtube directly; only the CLIENT
// must never see a google domain (that stays true: bytes are re-proxied).
// -- innertube WEB search: youtube's own ranked order, continuation tokens, shorts filter --
function searchItems(d) {
	const out = [], shorts = [];
	const seenIds = new Set(); // youtube repeats renderers across shelf sections - dup ids crash keyed each-blocks
	for (const vr of walkAll(d, "videoRenderer")) {
		const id = vr.videoId || "";
		if (!/^[a-zA-Z0-9_-]{11}$/.test(id) || seenIds.has("v" + id)) continue;
		seenIds.add("v" + id);
		let live = false, dur = "";
		if (vr.lengthText && vr.lengthText.simpleText) dur = vr.lengthText.simpleText;
		else live = true; // no length text = live/upcoming
		for (const b of vr.badges || []) { if (/live/i.test((b.metadataBadgeRenderer && b.metadataBadgeRenderer.label) || "")) live = true; }
		if (live) continue;
		const title = ((vr.title && vr.title.runs) || [])[0];
		const ch = ((vr.ownerText && vr.ownerText.runs) || [])[0];
		let chId = "";
		try { chId = ch.navigationEndpoint.browseEndpoint.browseId || ""; } catch (e) {}
		let views = 0;
		const vt = (vr.viewCountText && vr.viewCountText.simpleText) || "";
		const vm = /([\d.,]+)\s*([KM])?\s*views/i.exec(vt);
		if (vm) { views = parseFloat(vm[1].replace(/,/g, "")); if (vm[2] === "K") views *= 1e3; if (vm[2] === "M") views *= 1e6; }
		out.push({ id, title: (title && title.text) || "", thumb: thumbFor(id), dur, uploader: (ch && ch.text) || "", chId, views: Math.round(views), live: false });
	}
	for (const sl of walkAll(d, "shortsLockupViewModel")) {
		const m = /shorts-shelf-item-([a-zA-Z0-9_-]{11})/.exec(sl.entityId || "");
		if (!m || seenIds.has("s" + m[1])) continue;
		seenIds.add("s" + m[1]);
		const t = String(sl.accessibilityText || "").replace(/, [\d.,]+ ?[a-z]* views? - play Short.*$/i, "");
		shorts.push({ id: m[1], title: t, short: true, thumb: thumbFor(m[1]) });
	}
	const channels = [], playlists = [];
	for (const cr of walkAll(d, "channelRenderer")) {
		const id = cr.channelId || "";
		if (!id || seenIds.has("c" + id)) continue;
		seenIds.add("c" + id);
		const name = (cr.title && cr.title.simpleText) || "";
		let avatar = "";
		try { const a = cr.thumbnail.thumbnails.slice(-1)[0].url; avatar = a.startsWith("//") ? "https:" + a : a; } catch (e) {}
		const st1 = (cr.subscriberCountText && cr.subscriberCountText.simpleText) || "";
		const st2 = (cr.videoCountText && cr.videoCountText.simpleText) || "";
		const subs = ([st1, st2].find((t) => /subscriber/i.test(t)) || "").replace(/ subscribers?$/i, "");
		const desc = ((cr.descriptionSnippet && cr.descriptionSnippet.runs) || []).map((r) => r.text).join("");
		channels.push({ id, name, avatar: avatar ? "/api/jetstream/img?u=" + b64(avatar) : "", subs, description: desc.slice(0, 120) });
	}
	for (const pr of walkAll(d, "playlistRenderer")) {
		const id = pr.playlistId || "";
		if (!id || seenIds.has("p" + id)) continue;
		seenIds.add("p" + id);
		const title = (pr.title && pr.title.simpleText) || "";
		let thumb = "";
		try { const t2 = pr.thumbnails[0].thumbnails.slice(-1)[0].url; thumb = t2.startsWith("//") ? "https:" + t2 : t2; } catch (e) {}
		const count = ((pr.videoCountText && pr.videoCountText.runs) || [])[0];
		const by = ((pr.longBylineText && pr.longBylineText.runs) || [])[0];
		playlists.push({ id, title, thumb: thumb ? "/api/jetstream/img?u=" + b64(thumb) : "", count: String((count && count.text) || pr.videoCount || ""), uploader: (by && by.text) || "" });
	}
	for (const lv of walkAll(d, "lockupViewModel")) {
		if (!/PLAYLIST/i.test(lv.contentType || "")) continue;
		const id = lv.contentId || "";
		if (!id || seenIds.has("p" + id)) continue;
		seenIds.add("p" + id);
		const meta = (lv.metadata && lv.metadata.lockupMetadataViewModel) || {};
		const title = (meta.title && meta.title.content) || "";
		let uploader = "";
		try { uploader = meta.metadata.contentMetadataViewModel.metadataRows[0].metadataParts[0].text.content || ""; } catch (e) {}
		let thumb = "", count = "";
		try { const srcs = lv.contentImage.collectionThumbnailViewModel.primaryThumbnail.thumbnailViewModel.image.sources; thumb = srcs[srcs.length - 1].url.split("?")[0]; } catch (e) {}
		try { count = (lv.contentImage.collectionThumbnailViewModel.primaryThumbnail.thumbnailViewModel.overlays[0].thumbnailOverlayBadgeViewModel.thumbnailBadges[0].thumbnailBadgeViewModel.text || "").replace(/ videos?$/i, ""); } catch (e) {}
		playlists.push({ id, title, thumb: thumb ? "/api/jetstream/img?u=" + b64(thumb) : "", count, uploader });
	}
	let cont = "";
	for (const c of walkAll(d, "continuationCommand")) { if (c && c.token) { cont = c.token; break; } }
	return { items: out, shorts, channels, playlists, cont };
}
async function innertubeSearch(body) {
	let lastErr = null;
	for (const key of INNERTUBE_KEYS) {
		try {
			const r = await fetch("https://www.youtube.com/youtubei/v1/search?key=" + key, {
				method: "POST",
				headers: { "content-type": "application/json", "user-agent": WEB_UA },
				body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: "2.20240926.00.00", hl: "en" } }, ...body }),
				signal: AbortSignal.timeout(15000),
			});
			if (!r.ok) { lastErr = new Error("search " + r.status); continue; }
			const d = await r.json();
			if (d && d.error) { lastErr = new Error("search: " + (d.error.message || "error")); continue; }
			return d;
		} catch (e) { lastErr = e; }
	}
	throw lastErr || new Error("innertube search failed");
}
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
			if (d.playabilityStatus && d.playabilityStatus.status !== "OK") {
				// age-gated videos sometimes still play through the embed client (9/26
				// research: ANDROID/WEB/MWEB all login-wall age gates; embed works when
				// the owner left embedding on). one cheap retry before giving up.
				if (d.playabilityStatus.status === "LOGIN_REQUIRED") {
					const emb = await innertubeEmbed(videoId, key).catch(() => null);
					if (emb) return emb;
				}
				lastErr = new Error("unplayable: " + d.playabilityStatus.status + (d.playabilityStatus.reason ? ": " + d.playabilityStatus.reason : ""));
				continue;
			}
			return d;
		} catch (e) { lastErr = e; }
	}
	throw lastErr || new Error("innertube failed");
}
async function innertubeEmbed(videoId, key) {
	const r = await fetch("https://www.youtube.com/youtubei/v1/player?key=" + key, {
		method: "POST",
		headers: { "content-type": "application/json", "user-agent": WEB_UA },
		body: JSON.stringify({ context: { client: { clientName: "WEB_EMBEDDED_PLAYER", clientVersion: "1.20240925.01.00", hl: "en", clientScreen: "EMBED" }, thirdParty: { embedUrl: "https://www.youtube.com/" } }, contentCheckOk: true, racyCheckOk: true, videoId }),
		signal: AbortSignal.timeout(12000),
	});
	if (!r.ok) return null;
	const d = await r.json();
	if (d.playabilityStatus && d.playabilityStatus.status === "OK" && d.streamingData) return d;
	return null;
}
// channel + playlist pages come from the WEB innertube browse endpoint.
async function innertubeBrowse(browseId, cont, params) {
	let lastErr = null;
	for (const key of INNERTUBE_KEYS) {
		try {
			const r = await fetch("https://www.youtube.com/youtubei/v1/browse?key=" + key, {
				method: "POST",
				headers: { "content-type": "application/json", "user-agent": WEB_UA },
				body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: "2.20240926.00.00", hl: "en" } }, ...(cont ? { continuation: cont } : { browseId, ...(params ? { params } : {}) }) }),
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
// youtube signs timedtext urls over fmt, so we take srv3 xml and convert
function srv3ToVtt(xml) {
	const ts = (ms) => {
		ms = Number(ms) || 0;
		const h = Math.floor(ms / 3600000), m2 = Math.floor(ms / 60000) % 60, s2 = Math.floor(ms / 1000) % 60, mss = ms % 1000;
		return String(h).padStart(2, "0") + ":" + String(m2).padStart(2, "0") + ":" + String(s2).padStart(2, "0") + "." + String(mss).padStart(3, "0");
	};
	const deq = (t) => t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
	const rows = [];
	const re = /<p[^>]*?\st="(\d+)"[^>]*?>([\s\S]*?)<\/p>/g;
	let m;
	while ((m = re.exec(xml))) {
		const dm = /\sd="(\d+)"/.exec(m[0]);
		const start = Number(m[1]);
		const end = start + (dm ? Number(dm[1]) : 4000);
		const text = deq(m[2].replace(/<[^>]+>/g, "")).trim();
		if (text) rows.push(ts(start) + " --> " + ts(end) + "\n" + text + "\n");
	}
	return "WEBVTT\n\n" + rows.join("\n");
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
	let dur = "", live = false;
	for (const b of walkAll(l.contentImage, "thumbnailBadgeViewModel")) {
		const t = b.text || "";
		if (/\d+:\d\d/.test(t)) { dur = t; break; }
		if (/^\s*live\s*$/i.test(t)) live = true;
	}
	return { id: l.contentId, title, thumb: thumbFor(l.contentId), dur, metaText: parts.join(" · "), live };
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
function lockupPl(l) {
	if (!l || l.contentType !== "LOCKUP_CONTENT_TYPE_PLAYLIST") return null;
	const md = l.metadata && l.metadata.lockupMetadataViewModel;
	const title = (md && md.title && md.title.content) || "";
	let thumb = "";
	try {
		const sources = l.contentImage.thumbnailViewModel.image.sources || [];
		if (sources.length) thumb = "/api/jetstream/img?u=" + b64(sources[sources.length - 1].url);
	} catch (e) {}
	if (!l.contentId || !title) return null;
	return { id: l.contentId, title, thumb };
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
	// HD: adaptive video-only (avc1, <=1080p) + best m4a audio. the client plays
	// them as a synced video+audio pair (no server transcode, cpu stays idle).
	const adapt = (d.streamingData && d.streamingData.adaptiveFormats) || [];
	const seenH = new Set();
	const hdVideos = adapt
		.filter((f) => f && f.url && /video\/mp4/.test(f.mimeType || "") && /avc1/.test(f.mimeType || "") && (f.height || 0) > 360 && (f.height || 0) <= 1080)
		.sort((a, b) => (b.height || 0) - (a.height || 0))
		.filter((f) => { if (seenH.has(f.height)) return false; seenH.add(f.height); return true; })
		.map((f) => ({ q: f.qualityLabel, h: f.height, src: "/api/jetstream/stream?u=" + b64(f.url) }));
	const audioF = adapt
		.filter((f) => f && f.url && /audio\/mp4/.test(f.mimeType || ""))
		.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
	const hd = hdVideos.length && audioF ? { videos: hdVideos, audio: "/api/jetstream/stream?u=" + b64(audioF.url) } : null;
	// caption tracks - proxied through us as webvtt so the client never leaves origin
	let captions = [];
	try {
		const tracks = (d.captions && d.captions.playerCaptionsTracklistRenderer && d.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
		captions = tracks.map((t) => ({
			lang: t.languageCode || "",
			label: (t.name && (t.name.simpleText || (t.name.runs || [])[0] && t.name.runs[0].text)) || t.languageCode || "",
			auto: t.kind === "asr",
			src: "/api/jetstream/cap?u=" + b64(t.baseUrl),
		})).filter((c) => c.lang);
		captions.sort((a, b) => (a.lang.startsWith("en") ? -1 : 1) - (b.lang.startsWith("en") ? -1 : 1) || (a.auto ? 1 : 0) - (b.auto ? 1 : 0));
	} catch (e) {}
	// hqdefault always exists (maxres 404s on plenty of videos)
	const thumbUrl = "https://i.ytimg.com/vi/" + v + "/hqdefault.jpg";
	// best-effort related via piped search on the uploader; fine if it fails
	let related = [];
	try {
		const d2 = await api("/search?q=" + encodeURIComponent(vd.author || "") + "&filter=videos");
		related = (d2 && Array.isArray(d2.items) ? d2.items : []).filter((x) => x && x.type === "stream" && x.url && !x.url.includes(v)).slice(0, 18).map(item).filter((x) => !x.live);
	} catch (e) {}
	return { ok: true, id: v, title: vd.title || "", uploader: vd.author || "", chId: vd.channelId || "", thumb: "/api/jetstream/img?u=" + b64(thumbUrl), dur: fmtDur(vd.lengthSeconds), views: Number(vd.viewCount) || 0, likes: 0, uploaded: "", description: String(vd.shortDescription || "").slice(0, 2000), streams, hd, related, live: !!vd.isLiveContent, vertical, captions };
}

export default async function handle(req, res, route, url, ctx) {
	if (!ctx.user) { json(res, 401, { error: "no session" }); return; }
	try {
		if (route === "trending" && req.method === "GET") {
			// blend several regions - one region's trending is ~20 vids and can be
			// wall-to-wall live (filtered here), so a single region can come back empty
			const blend = async () => {
				const regions = ["US", "GB", "CA", "AU", "DE", "IN"];
				const all = await Promise.allSettled(regions.map((r) => api("/trending?region=" + r)));
				const seen = new Set(), out = [];
				for (const r of all) {
					if (r.status !== "fulfilled" || !Array.isArray(r.value)) continue;
					for (const x of r.value) {
						if (!x || !x.url || seen.has(x.url)) continue;
						seen.add(x.url);
						out.push(x);
					}
				}
				return out;
			};
			// a sparse blend means an upstream blip, not a quiet day - never cache it
			// for the full ttl or the feed sits empty for 10 minutes. retry once, and
			// only cache when the blend actually has content.
			const hit = apiCache.get("trending:blend");
			let d = hit && Date.now() - hit.ts < 10 * 60 * 1000 ? hit.data : null;
			if (!Array.isArray(d)) {
				d = await blend();
				if (d.length < 8) {
					await new Promise((r) => setTimeout(r, 1500));
					const again = await blend();
					if (again.length > d.length) d = again;
				}
				if (d.length >= 8) {
					apiCache.set("trending:blend", { data: d, ts: Date.now() });
					if (apiCache.size > API_CACHE_MAX) apiCache.delete(apiCache.keys().next().value);
				}
			}
			const arr = (Array.isArray(d) ? d : []).filter((x) => x && x.url);
			const liveByDuration = arr.length === 0 || arr.filter((x) => x.duration === -1).length * 2 < arr.length;
			let items = preferPlayable(arr.map((x) => item(x, liveByDuration)));
			// Luke 9/26: trending can be wall-to-wall livestreams (saturday nights),
			// and filtering leaves an empty row. top up from youtube's own trending
			// browse - the innertube parser drops lives via the lengthText rule, so
			// only playable videos backfill.
			if (items.length < 12) {
				try {
					// FEtrending 400s on every client now (9/26) - backfill from broad
					// innertube searches instead; searchItems already drops lives.
					const seeds = ["official music video", "official trailer", "gameplay", "highlights", "podcast"];
					const have = new Set(items.map((x) => x.id));
					for (const q of seeds) {
						if (items.length >= 24) break;
						const d = await cached("ytseed:" + q, 10 * 60 * 1000, () => innertubeSearch({ query: q, params: "EgIQAQ==" }));
						for (const e of searchItems(d).items) {
							if (items.length >= 24 || have.has(e.id)) continue;
							have.add(e.id);
							items.push(e);
						}
					}
				} catch (e) {}
			}
			return json(res, 200, { ok: true, items }, req);
		}
		if (route === "search" && req.method === "GET") {
			const q = (url.searchParams.get("q") || "").trim();
			const cont = (url.searchParams.get("cont") || "").trim();
			const filt = url.searchParams.get("filter") || "";
			const wantShorts = filt === "shorts";
			const wantAll = filt === "all";
			const wantChannels = filt === "channels";
			const wantPlaylists = filt === "playlists";
			if (!q && !cont) return json(res, 400, { error: "missing q" });
			try {
				const params = wantAll ? "" : wantShorts ? "EgIYAQ==" : wantChannels ? "EgIQAg==" : wantPlaylists ? "EgIQAw==" : "EgIQAQ==";
				const body = cont ? { continuation: cont } : { query: q, ...(params ? { params } : {}) };
				const d = await cached("ytsearch:" + (cont || q + ":" + (params || "a")), 10 * 60 * 1000, () => innertubeSearch(body));
				const r = searchItems(d);
				if (wantChannels) return json(res, 200, { ok: true, items: r.channels.slice(0, 12), continuation: r.cont }, req);
				if (wantPlaylists) return json(res, 200, { ok: true, items: r.playlists.slice(0, 12), continuation: r.cont }, req);
				if (wantAll) {
					let pls = r.playlists;
					if (!cont) {
						try {
							const d2 = await cached("ytsearch:" + q + ":EgIQAw==", 10 * 60 * 1000, () => innertubeSearch({ query: q, params: "EgIQAw==" }));
							pls = searchItems(d2).playlists;
						} catch (e) {}
					}
					return json(res, 200, { ok: true, videos: r.items.slice(0, 8), channels: r.channels.slice(0, 3), playlists: pls.slice(0, 3), shorts: r.shorts.slice(0, 8), continuation: r.cont }, req);
				}
				return json(res, 200, { ok: true, items: wantShorts ? r.shorts : r.items, continuation: r.cont }, req);
			} catch (e) {
				if (cont || wantShorts) throw e;
				const d = await cachedApi("/search?q=" + encodeURIComponent(q) + "&filter=videos", 5 * 60 * 1000);
				const items = (d && Array.isArray(d.items) ? d.items : []).filter((x) => x && x.type === "stream" && x.url).map(item);
				return json(res, 200, { ok: true, items: preferPlayable(items), continuation: "" }, req);
			}
		}
		if (route === "suggest" && req.method === "GET") {
			const q = (url.searchParams.get("q") || "").trim();
			if (!q || q.length > 80) return json(res, 200, { ok: true, items: [] }, req);
			let items = [];
			try {
				items = await cached("sug:" + q.toLowerCase(), 30 * 60 * 1000, async () => {
					// youtube's own suggest endpoint - server-side only, the client never sees a google domain
					const r = await fetch("https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&hl=en&q=" + encodeURIComponent(q), { headers: { "user-agent": WEB_UA }, signal: AbortSignal.timeout(8000) });
					if (!r.ok) throw new Error("suggest " + r.status);
					const txt = await r.text();
					const arr = JSON.parse(txt.slice(txt.indexOf("(") + 1, txt.lastIndexOf(")")));
					return (arr[1] || []).map((x) => (Array.isArray(x) ? x[0] : x)).filter((x) => typeof x === "string").slice(0, 7);
				});
			} catch (e) {}
			return json(res, 200, { ok: true, items }, req);
		}
		if (route === "search-channels" && req.method === "GET") {
			const q = (url.searchParams.get("q") || "").trim();
			if (!q) return json(res, 400, { error: "missing q" });
			const d = await cachedApi("/search?q=" + encodeURIComponent(q) + "&filter=channels", 5 * 60 * 1000);
			const items = (d && Array.isArray(d.items) ? d.items : []).filter((x) => x && x.type === "channel" && x.url).slice(0, 6).map((x) => ({
				id: (x.url || "").split("/channel/").pop(), name: x.name || "", subs: x.subscriberCount > 0 ? x.subscriberCount : 0,
				avatar: x.thumbnail ? "/api/jetstream/img?u=" + b64(x.thumbnail) : "", description: String(x.description || "").slice(0, 120),
			}));
			return json(res, 200, { ok: true, items }, req);
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
		function gridContToken(d) {
			for (const cir of walkAll(d, "continuationItemRenderer")) {
				const t = cir && cir.continuationEndpoint && cir.continuationEndpoint.continuationCommand && cir.continuationEndpoint.continuationCommand.token;
				if (t) return t;
			}
			return "";
		}
		if (route === "channel" && req.method === "GET") {
			const pvidsHome = (v) => v.filter((x) => !x.live);
			const id = (url.searchParams.get("id") || "").trim();
			const cont = (url.searchParams.get("cont") || "").trim();
			if (!cont && !/^[a-zA-Z0-9_-]{20,40}$/.test(id)) return json(res, 400, { error: "bad channel id" });
			// continuation pages: just the next batch of videos + the next token
			if (cont) {
				const d2 = await innertubeBrowse(null, cont);
				const seen2 = new Set(), vids2 = [];
				for (const l of walkAll(d2, "lockupViewModel")) {
					const it = lockupItem(l);
					if (it && !seen2.has(it.id)) { seen2.add(it.id); vids2.push(it); }
				}
				const next2 = gridContToken(d2);
				return json(res, 200, { ok: true, videos: vids2.filter((x) => !x.live), continuation: next2 }, req);
			}
			const d = await cached("browse:" + id, 10 * 60 * 1000, () => innertubeBrowse(id));
			// the channel's own tab endpoints (params come from youtube, never hardcoded)
			const tabParams = {};
			for (const t of walkAll(d, "tabRenderer")) {
				const title = String((t && t.title) || "").toLowerCase();
				const p = t && t.endpoint && t.endpoint.browseEndpoint && t.endpoint.browseEndpoint.params;
				if (p && !tabParams[title]) tabParams[title] = p;
			}
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
			const pls = [];
			for (const l of walkAll(d, "lockupViewModel")) {
				const pl = lockupPl(l);
				if (pl && !seen.has(pl.id)) { seen.add(pl.id); pls.push(pl); }
			}
			const shorts = [];
			for (const s of walkAll(d, "shortsLockupViewModel")) {
				const m = /shorts-shelf-item-([a-zA-Z0-9_-]{11})/.exec(s.entityId || "");
				if (!m || seen.has(m[1])) continue;
				seen.add(m[1]);
				const t = String(s.accessibilityText || "").replace(/, [\d.,]+ ?[a-z]* views? - play Short.*$/i, "");
				shorts.push({ id: m[1], title: t, short: true, thumb: thumbFor(m[1]) });
			}
			// videos tab: the real catalog grid + its own continuation (home-page
			// shelves cap out ~24 and their tokens page the wrong thing)
			let vids2 = pvidsHome(videos), chCont = "";
			if (tabParams.videos) {
				try {
					const dv = await cached("browse:" + id + ":videos", 10 * 60 * 1000, () => innertubeBrowse(id, null, tabParams.videos));
					const seen3 = new Set(), tv = [];
					for (const l of walkAll(dv, "lockupViewModel")) {
						const it = lockupItem(l);
						if (it && !seen3.has(it.id)) { seen3.add(it.id); tv.push(it); }
					}
					if (tv.length) vids2 = tv.filter((x) => !x.live);
					chCont = gridContToken(dv);
				} catch (e) {}
			}
			// shorts + playlists tabs (home shelves often miss them entirely)
			let shorts2 = shorts, pls2 = pls;
			if (tabParams.shorts) {
				try {
					const ds = await cached("browse:" + id + ":shorts", 10 * 60 * 1000, () => innertubeBrowse(id, null, tabParams.shorts));
					const ss = [], seen4 = new Set();
					for (const l of walkAll(ds, "shortsLockupViewModel")) {
						const m = /shorts-shelf-item-([a-zA-Z0-9_-]{11})/.exec(l.entityId || "");
						if (!m || seen4.has(m[1])) continue;
						seen4.add(m[1]);
						const t = String(l.accessibilityText || "").replace(/, [\d.,]+ ?[a-z]* views? - play Short.*$/i, "");
						ss.push({ id: m[1], title: t, short: true, thumb: thumbFor(m[1]) });
					}
					if (ss.length) shorts2 = ss;
				} catch (e) {}
			}
			const plTab = tabParams.playlists || tabParams.shows;
			if (plTab) {
				try {
					const dp = await cached("browse:" + id + ":playlists", 10 * 60 * 1000, () => innertubeBrowse(id, null, plTab));
					const pp = [], seen5 = new Set();
					const pushPl = (pid, title, thumbUrl) => {
						if (!pid || !title || seen5.has(pid)) return;
						seen5.add(pid);
						pp.push({ id: pid, title, thumb: thumbUrl ? "/api/jetstream/img?u=" + b64(thumbUrl) : "" });
					};
					for (const l of walkAll(dp, "lockupViewModel")) {
						const pl = lockupPl(l);
						if (pl) pushPl(pl.id, pl.title, (pl.thumb.match(/u=(.*)$/) || [])[1] ? decodeURIComponent(pl.thumb.split("u=")[1]) : "");
					}
					// classic playlist grid + shows grid (shows are VL<playlistId> under the hood)
					for (const g of walkAll(dp, "gridPlaylistRenderer")) {
						const t = g.title && (g.title.simpleText || (g.title.runs && g.title.runs[0] && g.title.runs[0].text));
						const th = g.thumbnail && g.thumbnail.thumbnails && g.thumbnail.thumbnails.slice(-1)[0];
						pushPl(g.playlistId, t, th && th.url);
					}
					for (const g of walkAll(dp, "gridShowRenderer")) {
						const t = g.title && (g.title.simpleText || (g.title.runs && g.title.runs[0] && g.title.runs[0].text));
						const bid = g.navigationEndpoint && g.navigationEndpoint.browseEndpoint && g.navigationEndpoint.browseEndpoint.browseId;
						const pid = bid && bid.startsWith("VL") ? bid.slice(2) : bid;
						const th = g.thumbnailRenderer && g.thumbnailRenderer.showCustomThumbnailRenderer && g.thumbnailRenderer.showCustomThumbnailRenderer.thumbnail && g.thumbnailRenderer.showCustomThumbnailRenderer.thumbnail.thumbnails && g.thumbnailRenderer.showCustomThumbnailRenderer.thumbnail.thumbnails.slice(-1)[0];
						pushPl(pid, t, th && th.url);
					}
					if (pp.length) pls2 = pp;
				} catch (e) {}
			}
			const pvids = vids2;
			const vidCount = (mtexts.find((t) => /[\d.,KM]+ videos?$/i.test(t)) || "").replace(/ videos?$/i, "");
			return json(res, 200, { ok: true, id, name: meta.title || (phv && phv.title && phv.title.dynamicTextViewModel && phv.title.dynamicTextViewModel.text && phv.title.dynamicTextViewModel.text.content) || "", description: String(meta.description || "").slice(0, 600), subs: mtexts.join(" · "), vidCount, avatar, videos: pvids.slice(0, 30), continuation: chCont, shorts: shorts2.slice(0, 20), playlists: pls2.slice(0, 12) }, req);
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
			return json(res, 200, { ok: true, id, title: pm.title || "playlist", videos: videos.filter((x) => !x.live).slice(0, 100) }, req);
		}
		if (route === "watch" && req.method === "GET") {
			const v = (url.searchParams.get("v") || "").trim();
			if (!/^[a-zA-Z0-9_-]{11}$/.test(v)) return json(res, 400, { error: "bad video id" });
			let watchErr = null;
			try {
				if (url.searchParams.has("fresh")) {
					const d = await watchViaInnertube(v);
					apiCache.set("watch:" + v, { data: d, ts: Date.now() });
					return json(res, 200, d, req);
				}
				return json(res, 200, await cached("watch:" + v, 5 * 60 * 1000, () => watchViaInnertube(v)), req);
			} catch (e) { watchErr = e; }
			let d;
			try {
				d = await cachedApi("/streams/" + v, 5 * 60 * 1000);
			} catch (e2) {
				const m = watchErr && /unplayable: ([A-Z_]+): (.+)/.exec(String(watchErr.message || ""));
				if (m) return json(res, 422, { error: m[2], status: m[1] });
				throw e2;
			}
			const streams = (d.videoStreams || [])
				.filter((s) => s && s.url && s.videoOnly === false && /\d+p/.test(s.quality || ""))
				.sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0))
				.slice(0, 3)
				.map((s) => ({ q: s.quality, src: "/api/jetstream/stream?u=" + b64(s.url) }));
			const seenH2 = new Set();
			const hdV = (d.videoStreams || [])
				.filter((x) => x && x.url && x.videoOnly === true && /\d+p/.test(x.quality || "") && parseInt(x.quality) > 360 && parseInt(x.quality) <= 1080 && /mp4/i.test(x.mimeType || x.codec || "mp4"))
				.sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0))
				.filter((x) => { const h = parseInt(x.quality); if (seenH2.has(h)) return false; seenH2.add(h); return true; })
				.map((x) => ({ q: x.quality, h: parseInt(x.quality), src: "/api/jetstream/stream?u=" + b64(x.url) }));
			const au = (d.audioStreams || []).filter((x) => x && x.url && /mp4|m4a/i.test(x.mimeType || x.codec || "mp4")).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
			const hd = hdV.length && au ? { videos: hdV, audio: "/api/jetstream/stream?u=" + b64(au.url) } : null;
			const related = (d.relatedStreams || []).filter((x) => x && x.url).slice(0, 18).map(item).filter((x) => !x.live);
			return json(res, 200, { ok: true, id: v, title: d.title || "", uploader: d.uploader || "", thumb: "/api/jetstream/img?u=" + b64(d.thumbnailUrl || ""), dur: fmtDur(d.duration), views: d.views || 0, likes: d.likes || 0, uploaded: d.uploadDate || "", description: String(d.description || "").slice(0, 2000), streams, hd, related, live: !!d.livestream, vertical: false });
		}
		if (route === "comments" && req.method === "GET") {
			const v = (url.searchParams.get("v") || "").trim();
			if (!/^[a-zA-Z0-9_-]{11}$/.test(v)) return json(res, 400, { error: "bad video id" });
			return json(res, 200, await cached("comments:" + v, 10 * 60 * 1000, () => commentsFor(v)), req);
		}
		if (route === "ymsearch" && req.method === "GET") {
			// youtube music catalog (Luke 9/26: YT music ok, not youtube.com videos) -
			// the WEB_REMIX innertube client, audio-only playback via the watch route.
			const q = (url.searchParams.get("q") || "").trim();
			if (!q) return json(res, 400, { error: "missing q" }, req);
			try {
				const d = await cached("ymsearch:" + q.toLowerCase(), 10 * 60 * 1000, async () => {
					let lastErr = null;
					for (const key of INNERTUBE_KEYS) {
						try {
							const r = await fetch("https://music.youtube.com/youtubei/v1/search?key=" + key, {
								method: "POST",
								headers: { "content-type": "application/json", "user-agent": WEB_UA },
								body: JSON.stringify({ context: { client: { clientName: "WEB_REMIX", clientVersion: "1.20240925.01.00", hl: "en" } }, query: q }),
								signal: AbortSignal.timeout(15000),
							});
							if (!r.ok) { lastErr = new Error("ym " + r.status); continue; }
							const j = await r.json();
							if (j && j.error) { lastErr = new Error("ym: " + (j.error.message || "error")); continue; }
							return j;
						} catch (e) { lastErr = e; }
					}
					throw lastErr || new Error("ym search failed");
				});
				const seen = new Set(), items = [];
				for (const it of walkAll(d, "musicResponsiveListItemRenderer")) {
					let videoId = "";
					try { videoId = it.playlistItemData.videoId || ""; } catch (e) {}
					if (!videoId) { try { videoId = it.overlay.musicItemThumbnailOverlayRenderer.content.musicPlayButtonRenderer.playNavigationEndpoint.watchEndpoint.videoId || ""; } catch (e) {} }
					if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId) || seen.has(videoId)) continue;
					seen.add(videoId);
					const cols = (it.flexColumns || []).map((c) => ((c.musicResponsiveListItemFlexColumnRenderer && c.musicResponsiveListItemFlexColumnRenderer.text && c.musicResponsiveListItemFlexColumnRenderer.text.runs) || []));
					const fixed = (it.fixedColumns || []).map((c) => ((c.musicResponsiveListItemFixedColumnRenderer && c.musicResponsiveListItemFixedColumnRenderer.text && c.musicResponsiveListItemFixedColumnRenderer.text.runs) || []));
					const title = ((cols[0] || [])[0] || {}).text || "";
					const metaTexts = (cols[1] || []).map((r) => r.text).filter((t) => t && !/^[\u2022\s]+$/.test(t));
					const allFixed = fixed.flat().map((r) => r.text).join(" ");
					const allFlex = cols.slice(1).flat().map((r) => r.text).join(" ");
					const dm = /(\d+:)?\d+:\d+/.exec(allFixed) || /(\d+:)?\d+:\d+/.exec(allFlex);
					const dur = dm ? dm[0] : "";
					const secs = dur ? dur.split(":").reduce((a, x) => a * 60 + parseInt(x), 0) : 0;
					const type = metaTexts[0] || "";
					if (type && type !== "Song" && type !== "Single") continue; // songs only
					const uploader = metaTexts.filter((t) => t !== type && !/^(\d+:)?\d+:\d+$/.test(t))[0] || "";
					let thumb = "";
					try { const th = it.thumbnail.musicThumbnailRenderer.thumbnail.thumbnails; thumb = th[th.length - 1].url; } catch (e) {}
					if (!title) continue;
					items.push({ id: videoId, title, uploader, thumb: thumb ? "/api/jetstream/img?u=" + b64(thumb) : "", dur, durSec: secs, yt: true });
				}
				return json(res, 200, { ok: true, items: items.slice(0, 20) }, req);
			} catch (e) { return json(res, 502, { error: "ytmusic failed" }, req); }
		}
		if (route === "scsearch" && req.method === "GET") {
			// soundcloud public-web search (what real proxy music sites use).
			const q = (url.searchParams.get("q") || "").trim();
			if (!q) return json(res, 400, { error: "missing q" }, req);
			try {
				const d = await cached("scsearch:" + q.toLowerCase(), 10 * 60 * 1000, async () => {
					const cid = await scClientId();
					const r = await fetch("https://api-v2.soundcloud.com/search/tracks?q=" + encodeURIComponent(q) + "&limit=24&client_id=" + cid, { headers: { "user-agent": WEB_UA }, signal: AbortSignal.timeout(15000) });
					if (!r.ok) throw new Error("sc " + r.status);
					return r.json();
				});
				// only tracks with a progressive (plain-mp3) transcoding can stream through
				// scstream - encrypted-hls-only tracks cannot play in a browser.
				const items = (d.collection || []).filter((t) => {
					if (!t || !t.id || t.streamable === false) return false;
					const tcs = (t.media && t.media.transcodings) || [];
					return tcs.length === 0 || tcs.some((x) => x.format && x.format.protocol === "progressive");
				}).map((t) => ({
					id: "sc-" + t.id,
					title: t.title || "",
					uploader: (t.user && t.user.username) || "",
					thumb: t.artwork_url ? "/api/jetstream/img?u=" + b64(t.artwork_url.replace("-large", "-t500x500")) : "",
					dur: fmtDur((t.duration || 0) / 1000), durSec: Math.round((t.duration || 0) / 1000),
					src: "/api/jetstream/scstream?id=" + t.id,
					sc: true,
				}));
				return json(res, 200, { ok: true, items }, req);
			} catch (e) { return json(res, 502, { error: "soundcloud failed" }, req); }
		}
		if (route === "scstream" && req.method === "GET") {
			const id = (url.searchParams.get("id") || "").trim();
			if (!/^\d{5,15}$/.test(id)) return json(res, 400, { error: "bad id" }, req);
			try {
				const cid = await scClientId();
				// signed progressive urls expire in minutes - cache the resolve only briefly,
				// and re-resolve once if the upstream rejects the cached one.
				const resolveMedia = async () => await cached("scmedia:" + id, 45 * 1000, async () => {
					const r = await fetch("https://api-v2.soundcloud.com/tracks/" + id + "?client_id=" + cid, { headers: { "user-agent": WEB_UA }, signal: AbortSignal.timeout(15000) });
					if (!r.ok) throw new Error("sc track " + r.status);
					const t = await r.json();
					const tc = (t.media && t.media.transcodings || []).find((x) => x.format && x.format.protocol === "progressive" && /mp3/.test(x.format.mime_type || ""))
						|| (t.media && t.media.transcodings || []).find((x) => x.format && x.format.protocol === "progressive");
					if (!tc) throw new Error("no progressive stream");
					const r2 = await fetch(tc.url + "?client_id=" + cid, { headers: { "user-agent": WEB_UA }, signal: AbortSignal.timeout(15000) });
					if (!r2.ok) throw new Error("sc resolve " + r2.status);
					const j = await r2.json();
					if (!j || !j.url) throw new Error("no url");
					return j.url;
				});
				let media = await resolveMedia();
				const headers = { "user-agent": WEB_UA };
				if (req.headers.range) headers.range = req.headers.range;
				let r = await fetch(media, { headers, redirect: "follow", signal: AbortSignal.timeout(30000) });
				if (!r.ok && r.status !== 206) {
					apiCache.delete("scmedia:" + id);
					media = await resolveMedia();
					r = await fetch(media, { headers, redirect: "follow", signal: AbortSignal.timeout(30000) });
					if (!r.ok && r.status !== 206) { res.writeHead(502); return res.end(); }
				}
				const h = { "cache-control": "public, max-age=3600" };
				for (const k of ["content-type", "content-length", "content-range", "accept-ranges"]) {
					const val = r.headers.get(k);
					if (val) h[k] = val;
				}
				if (!h["content-type"]) h["content-type"] = "audio/mpeg";
				res.writeHead(r.status === 206 ? 206 : 200, h);
				if (!r.body) return res.end();
				for await (const chunk of r.body) {
					if (!res.write(chunk)) await new Promise((d2) => res.once("drain", d2));
				}
				return res.end();
			} catch (e) { res.writeHead(502); return res.end(); }
		}
		if (route === "auimg" && req.method === "GET") {
			// audius artwork: content nodes are arbitrary hosts, so validate the
			// request shape instead - https, no creds, /content/<cid>/<size>.<ext>
			const u = unb64(url.searchParams.get("u") || "");
			let pu = null;
			try { pu = new URL(u); } catch (e) {}
			if (!pu || pu.protocol !== "https:" || pu.username || pu.password || !/^\/content\/[A-Za-z0-9]{20,64}\/[0-9]{2,4}x[0-9]{2,4}\.(jpg|jpeg|png|webp)$/i.test(pu.pathname)) {
				return json(res, 400, { error: "bad url" }, req);
			}
			const r = await fetch(u, { headers: { "user-agent": "ramjet-amp/1.0" }, redirect: "follow", signal: AbortSignal.timeout(15000) });
			if (!r.ok) { res.writeHead(502); return res.end(); }
			const h = { "cache-control": "public, max-age=86400", "content-type": r.headers.get("content-type") || "image/jpeg" };
			const cl = r.headers.get("content-length");
			if (cl) h["content-length"] = cl;
			res.writeHead(200, h);
			if (!r.body) return res.end();
			for await (const chunk of r.body) {
				if (!res.write(chunk)) await new Promise((d2) => res.once("drain", d2));
			}
			return res.end();
		}
		if (route === "austream" && req.method === "GET") {
			// audius stream proxy (amp): the content nodes sit behind cloudflare browser
			// checks that reject media-element loads - server-to-server sails through.
			const id = (url.searchParams.get("id") || "").trim();
			if (!/^[A-Za-z0-9]{1,24}$/.test(id)) return json(res, 400, { error: "bad id" }, req);
			const headers = { "user-agent": "ramjet-amp/1.0" };
			if (req.headers.range) headers.range = req.headers.range;
			const r = await fetch("https://discoveryprovider.audius.co/v1/tracks/" + id + "/stream?app_name=goattech-amp", { headers, redirect: "follow", signal: AbortSignal.timeout(30000) });
			if (!r.ok && r.status !== 206) { res.writeHead(502); return res.end(); }
			const h = { "cache-control": "public, max-age=3600" };
			for (const k of ["content-type", "content-length", "content-range", "accept-ranges"]) {
				const val = r.headers.get(k);
				if (val) h[k] = val;
			}
			if (!h["content-type"]) h["content-type"] = "audio/mpeg";
			res.writeHead(r.status === 206 ? 206 : 200, h);
			if (!r.body) return res.end();
			for await (const chunk of r.body) {
				if (!res.write(chunk)) await new Promise((d2) => res.once("drain", d2));
			}
			return res.end();
		}
		if ((route === "stream" || route === "img" || route === "cap") && req.method === "GET") {
			const u = unb64(url.searchParams.get("u") || "");
			if (!u || !proxyHostOK(u)) return json(res, 400, { error: "bad url" });
			// googlevideo throttles long reads to a stall after ~1MB (the n-challenge),
			// but every fresh range request gets a full-speed burst. for open-ended
			// reads (how browsers stream media) fetch 1MB chunks and stitch them.
			if (route === "stream" && /(^|\.)googlevideo\.com$/.test(new URL(u).hostname)) {
				const rm = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
				if (!req.headers.range || (rm && !rm[2])) {
					const start = rm ? parseInt(rm[1], 10) : 0;
					const CHUNK = 1 << 20;
					let pos = start, total = -1, sent = false, dead = false, cur = null;
					// kill the upstream read the moment the client leaves - googlevideo
					// 403s a second connection while an abandoned one is still draining.
					res.once("close", () => { dead = true; try { if (cur && cur.body) cur.body.cancel(); } catch (e) {} });
					try {
						while (!dead) {
							let r = await fetch(u, { headers: { "user-agent": "ramjet-jetstream/1.2", range: "bytes=" + pos + "-" + (pos + CHUNK - 1) }, redirect: "follow", signal: AbortSignal.timeout(30000) });
							if (r.status === 403 || r.status === 429) {
								try { r.body && r.body.cancel(); } catch (e) {}
								await new Promise((d2) => setTimeout(d2, 400));
								r = await fetch(u, { headers: { "user-agent": "ramjet-jetstream/1.2", range: "bytes=" + pos + "-" + (pos + CHUNK - 1) }, redirect: "follow", signal: AbortSignal.timeout(30000) });
							}
							cur = r;
							if (r.status !== 206 && r.status !== 200) { if (!sent) res.writeHead(502); return res.end(); }
							if (!sent) {
								const cr = r.headers.get("content-range") || "";
								const mt = /\/(\d+)$/.exec(cr);
								total = mt ? parseInt(mt[1], 10) : -1;
								const h = { "content-type": r.headers.get("content-type") || "video/mp4", "cache-control": "private, no-store" };
								if (rm) {
									h["accept-ranges"] = "bytes";
									if (total > 0) h["content-range"] = "bytes " + start + "-" + (total - 1) + "/" + total;
									res.writeHead(206, h);
								} else {
									if (total > 0) h["content-length"] = String(total);
									res.writeHead(200, h);
								}
								sent = true;
							}
							let got = 0;
							if (r.body) {
								for await (const chunk of r.body) {
									got += chunk.length;
									if (dead || !res.write(chunk)) { if (dead) break; await new Promise((d2) => res.once("drain", d2)); }
								}
							}
							pos += got;
							if (got === 0 || (total > 0 && pos >= total)) break;
						}
					} catch (e) { /* client left or upstream stalled - nothing more to do */ }
					return res.end();
				}
			}
			const headers = { "user-agent": "ramjet-jetstream/1.2" };
			if (route === "stream" && req.headers.range) headers.range = req.headers.range;
			const r = await fetch(u, { headers, redirect: "follow", signal: AbortSignal.timeout(30000) });
			if (route === "cap") {
				if (!r.ok) { res.writeHead(502); return res.end(); }
				const xml = await r.text();
				res.writeHead(200, { "content-type": "text/vtt; charset=utf-8", "cache-control": "public, max-age=86400" });
				return res.end(srv3ToVtt(xml));
			}
			const h = { "cache-control": route === "stream" ? "private, no-store" : "public, max-age=86400" };
			for (const k of ["content-type", "content-length", "content-range", "accept-ranges"]) {
				const val = r.headers.get(k);
				if (val) h[k] = val;
			}
			if (!h["content-type"]) h["content-type"] = route === "img" ? "image/jpeg" : route === "cap" ? "text/vtt; charset=utf-8" : "video/mp4";
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
