// jetstream client - hash-routed youtube frontend riding ramjet's session.
// per-user data (watch history, resume positions) syncs through ramjet's
// encrypted sync blob under the "jetstream" key, with a localStorage
// fallback when sync is locked or off.
const view = document.getElementById("view");
const qInput = document.getElementById("q");
const LS_KEY = "jetstream-store";

let store = { history: [], progress: {} };
let saveQueued = false;

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

async function api(path) {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const r = await fetch("/api/jetstream/" + path);
			if (r.status === 401) { location.href = "/login"; throw new Error("locked"); }
			if (!r.ok) throw new Error("api " + r.status);
			return await r.json();
		} catch (e) {
			if (e.message === "locked" || attempt === 1) throw e;
			await new Promise((res) => setTimeout(res, 1200));
		}
	}
}

// -- per-user store -----------------------------------------------------------
function loadLocal() {
	try { const s = JSON.parse(localStorage.getItem(LS_KEY) || "null"); if (s && typeof s === "object") store = { history: s.history || [], progress: s.progress || {} }; } catch (e) {}
}
async function loadRemote() {
	if (typeof RJCrypto === "undefined") return;
	try {
		if (!RJCrypto.unlocked()) await RJCrypto.tryRestore();
		if (!RJCrypto.unlocked()) return;
		const blob = await RJCrypto.pull();
		if (blob && blob.jetstream && typeof blob.jetstream === "object") {
			store = { history: blob.jetstream.history || [], progress: blob.jetstream.progress || {} };
			try { localStorage.setItem(LS_KEY, JSON.stringify(store)); } catch (e) {}
		}
	} catch (e) {}
}
function save() {
	try { localStorage.setItem(LS_KEY, JSON.stringify(store)); } catch (e) {}
	if (saveQueued) return;
	saveQueued = true;
	setTimeout(async () => {
		saveQueued = false;
		if (typeof RJCrypto === "undefined" || !RJCrypto.unlocked()) return;
		try {
			const blob = (await RJCrypto.pull()) || {};
			blob.jetstream = { history: store.history.slice(0, 40), progress: store.progress };
			await RJCrypto.push(blob);
		} catch (e) {}
	}, 1200);
}
function durToSec(d) {
	const m = /^(\d+):(\d\d)$/.exec(d || "");
	return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}
function pushHistory(it) {
	store.history = store.history.filter((h) => h.id !== it.id);
	store.history.unshift({ id: it.id, title: it.title, uploader: it.uploader, thumb: it.thumb, dur: it.dur, durSec: durToSec(it.dur), at: Date.now() });
	store.history = store.history.slice(0, 40);
	save();
}
function setProgress(id, seconds) {
	if (!id || !isFinite(seconds) || seconds < 5) return;
	store.progress[id] = Math.floor(seconds);
	save();
}

// -- rendering ----------------------------------------------------------------
function fmtViews(v) {
	v = Number(v) || 0;
	if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M views";
	if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "K views";
	return v + " views";
}
function card(it) {
	const meta = [it.uploader, it.views ? fmtViews(it.views) : "", it.resume || ""].filter(Boolean).join(" · ");
	const pct = it.progressPct ? `<div class="watched"><div style="width:${Math.min(100, it.progressPct)}%"></div></div>` : "";
	return `<a class="card" href="#/w/${esc(it.id)}">
		<div class="thumbwrap"><img loading="lazy" src="${esc(it.thumb)}" alt="">${pct}<span class="dur">${esc(it.dur)}</span></div>
		<p class="ctitle">${esc(it.title)}</p>
		<p class="cmeta">${esc(meta)}</p>
	</a>`;
}
function grid(items) {
	if (!items.length) return '<p class="dim pad">nothing here.</p>';
	return '<div class="grid">' + items.map(card).join("") + "</div>";
}
function skeleton() {
	let s = '<div class="grid">';
	for (let i = 0; i < 8; i++) s += '<div class="skel"><div class="skel-thumb"></div><div class="skel-line"></div><div class="skel-line short"></div></div>';
	return s + "</div>";
}
function setTab(name) {
	for (const a of document.querySelectorAll(".tabs a")) a.classList.toggle("on", a.dataset.tab === name);
}
function errBox(msg) {
	view.innerHTML = `<div class="note"><p>${esc(msg)}</p><button class="plain" onclick="route()">retry</button></div>`;
}

async function showTrending() {
	setTab("home");
	view.innerHTML = skeleton();
	try {
		const d = await api("trending");
		view.innerHTML = grid(d.items || []);
	} catch (e) { errBox("trending won't load right now - the upstream is probably rate-limited."); }
}

async function showSearch(q) {
	setTab("");
	qInput.value = q;
	view.innerHTML = skeleton();
	try {
		const d = await api("search?q=" + encodeURIComponent(q));
		const items = d.items || [];
		view.innerHTML = `<h2 class="sec pad" style="padding-bottom:0">results for "${esc(q)}"</h2>` +
			(items.length ? grid(items) : '<p class="dim pad">no videos matched that.</p>');
	} catch (e) { errBox("search failed - give it another try."); }
}

async function showWatch(id) {
	setTab("");
	view.innerHTML = '<div class="watch"><div class="skel-player"></div><div class="skel-line" style="margin:14px 2px"></div><div class="skel-line short" style="margin:0 2px"></div></div>';
	let d;
	try { d = await api("watch?v=" + encodeURIComponent(id)); }
	catch (e) { return errBox("couldn't load that video."); }
	pushHistory({ id: d.id, title: d.title, uploader: d.uploader, thumb: d.thumb || "", dur: d.dur });
	const resume = store.progress[d.id] || 0;
	const hasStreams = d.streams && d.streams.length > 0;
	const src = hasStreams ? d.streams[0].src : "";
	const metaBits = [fmtViews(d.views), d.uploaded ? d.uploaded.slice(0, 10) : "", d.likes ? d.likes + " likes" : ""].filter(Boolean).join(" · ");
	view.innerHTML = `<div class="watch">
		${hasStreams
			? `<video class="player" id="player" controls playsinline preload="metadata" src="${esc(src)}"${d.thumb ? ` poster="${esc(d.thumb)}"` : ""}></video>`
			: `<div class="note">${d.live ? "this one's live - live playback isn't supported yet." : "no playable stream for this video."}</div>`}
		<p class="wtitle">${esc(d.title)}</p>
		<p class="wmeta"><a class="uplink" href="#/s/${encodeURIComponent(d.uploader)}">${esc(d.uploader)}</a>${metaBits ? " · " + esc(metaBits) : ""}</p>
		${hasStreams && d.streams.length > 1 ? `<div class="wrow"><label class="dim" for="qual">quality</label><select class="quality" id="qual">${d.streams.map((s, i) => `<option value="${i}">${esc(s.q)}</option>`).join("")}</select></div>` : ""}
		${d.description ? `<details class="desc"><summary>description</summary><pre>${esc(d.description)}</pre></details>` : ""}
		${d.related && d.related.length ? '<h2 class="sec">up next</h2>' : ""}
	</div>` + grid(d.related || []);
	if (hasStreams) wirePlayer(d, resume);
}

function wirePlayer(d, resume) {
	const v = document.getElementById("player");
	if (!v) return;
	let lastSave = 0;
	v.addEventListener("loadedmetadata", () => {
		if (resume > 10 && resume < v.duration - 10) v.currentTime = resume;
	});
	v.addEventListener("timeupdate", () => {
		if (Date.now() - lastSave > 5000) { lastSave = Date.now(); setProgress(d.id, v.currentTime); }
	});
	v.addEventListener("pause", () => setProgress(d.id, v.currentTime));
	window.addEventListener("pagehide", () => setProgress(d.id, v.currentTime), { once: true });
	// up next: roll straight into the first related video when this one ends
	v.addEventListener("ended", () => {
		setProgress(d.id, 0);
		const nxt = (d.related || [])[0];
		if (nxt) location.hash = "#/w/" + nxt.id;
	});
	const sel = document.getElementById("qual");
	if (sel) sel.addEventListener("change", () => {
		const t = v.currentTime, playing = !v.paused;
		v.src = d.streams[Number(sel.value)].src;
		v.currentTime = t;
		if (playing) v.play().catch(() => {});
	});
}

function showHistory() {
	setTab("history");
	if (!store.history.length) {
		view.innerHTML = '<p class="dim pad">nothing watched yet.</p>';
		return;
	}
	const items = store.history.map((h) => {
		const p = store.progress[h.id];
		return {
			...h,
			resume: p && h.durSec && p < h.durSec - 15 ? "resume " + Math.floor(p / 60) + ":" + String(p % 60).padStart(2, "0") : "",
			progressPct: p && h.durSec ? Math.round((p / h.durSec) * 100) : 0,
		};
	});
	view.innerHTML = `<h2 class="sec pad" style="padding-bottom:0">watch history</h2>` + grid(items) +
		`<div class="pad"><button class="plain" id="wipe">clear history</button></div>`;
	document.getElementById("wipe").addEventListener("click", () => {
		store.history = []; store.progress = {}; save(); showHistory();
	});
}

function route() {
	const h = location.hash || "#/";
	view.classList.remove("fade-in");
	void view.offsetWidth;
	view.classList.add("fade-in");
	if (h.startsWith("#/w/")) return showWatch(h.slice(4).split("?")[0]);
	if (h.startsWith("#/s/")) return showSearch(decodeURIComponent(h.slice(4)));
	if (h === "#/history") return showHistory();
	return showTrending();
}

document.getElementById("search").addEventListener("submit", (e) => {
	e.preventDefault();
	const q = qInput.value.trim();
	if (q) location.hash = "#/s/" + encodeURIComponent(q);
});
window.addEventListener("hashchange", route);
loadLocal();
route();
loadRemote().then(() => { if ((location.hash || "#/") === "#/history") showHistory(); });
