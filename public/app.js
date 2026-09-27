// jetstream client - hash-routed youtube frontend riding ramjet's session.
// per-user data (history, resume, settings, subscriptions) syncs through
// ramjet's encrypted sync blob under the "jetstream" key, localStorage
// fallback when sync is locked or off.
const view = document.getElementById("view");
const qInput = document.getElementById("q");
const LS_KEY = "jetstream-store";
const DEFAULT_SETTINGS = { autoplayNext: true, resume: true, quality: "auto" };

let store = { history: [], progress: {}, settings: { ...DEFAULT_SETTINGS }, subs: [] };
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
function norm(s) {
	if (!s || typeof s !== "object") return;
	store = {
		history: s.history || [],
		progress: s.progress || {},
		settings: { ...DEFAULT_SETTINGS, ...(s.settings || {}) },
		subs: Array.isArray(s.subs) ? s.subs : [],
	};
}
function loadLocal() {
	try { norm(JSON.parse(localStorage.getItem(LS_KEY) || "null")); } catch (e) {}
}
async function loadRemote() {
	if (typeof RJCrypto === "undefined") return;
	try {
		if (!RJCrypto.unlocked()) await RJCrypto.tryRestore();
		if (!RJCrypto.unlocked()) return;
		const blob = await RJCrypto.pull();
		if (blob && blob.jetstream) {
			norm(blob.jetstream);
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
			blob.jetstream = { history: store.history.slice(0, 40), progress: store.progress, settings: store.settings, subs: store.subs };
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
function isSubbed(name) { return store.subs.some((s) => s.name.toLowerCase() === String(name || "").toLowerCase()); }
function toggleSub(name, chId) {
	if (isSubbed(name)) store.subs = store.subs.filter((s) => s.name.toLowerCase() !== name.toLowerCase());
	else store.subs.unshift({ name, chId: chId || "", at: Date.now() });
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
	const resume = store.settings.resume ? (store.progress[d.id] || 0) : 0;
	const hasStreams = d.streams && d.streams.length > 0;
	let startIdx = 0;
	if (hasStreams && store.settings.quality !== "auto") {
		const qi = d.streams.findIndex((s) => s.q === store.settings.quality);
		if (qi >= 0) startIdx = qi;
	}
	const src = hasStreams ? d.streams[startIdx].src : "";
	const metaBits = [fmtViews(d.views), d.uploaded ? d.uploaded.slice(0, 10) : "", d.likes ? d.likes + " likes" : ""].filter(Boolean).join(" · ");
	const subbed = isSubbed(d.uploader);
	view.innerHTML = `<div class="watch">
		${hasStreams
			? `<video class="player" id="player" controls playsinline preload="metadata" src="${esc(src)}"${d.thumb ? ` poster="${esc(d.thumb)}"` : ""}></video>`
			: `<div class="note">${d.live ? "this one's live - live playback isn't supported yet." : "no playable stream for this video."}</div>`}
		<p class="wtitle">${esc(d.title)}</p>
		<div class="wsubrow">
			<p class="wmeta" style="margin:0"><a class="uplink" href="#/s/${encodeURIComponent(d.uploader)}">${esc(d.uploader)}</a>${metaBits ? " · " + esc(metaBits) : ""}</p>
			<button class="plain subbtn${subbed ? " on" : ""}" id="subbtn">${subbed ? "subscribed" : "subscribe"}</button>
		</div>
		${hasStreams && d.streams.length > 1 ? `<div class="wrow"><label class="dim" for="qual">quality</label><select class="quality" id="qual">${d.streams.map((s, i) => `<option value="${i}"${i === startIdx ? " selected" : ""}>${esc(s.q)}</option>`).join("")}</select></div>` : ""}
		${d.description ? `<details class="desc"><summary>description</summary><pre>${esc(d.description)}</pre></details>` : ""}
		${d.related && d.related.length ? '<h2 class="sec">up next</h2>' : ""}
	</div>` + grid(d.related || []);
	document.getElementById("subbtn").addEventListener("click", () => {
		toggleSub(d.uploader, d.chId || "");
		const b = document.getElementById("subbtn");
		const on = isSubbed(d.uploader);
		b.textContent = on ? "subscribed" : "subscribe";
		b.classList.toggle("on", on);
	});
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
	v.addEventListener("ended", () => {
		setProgress(d.id, 0);
		if (!store.settings.autoplayNext) return;
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

// -- subscriptions --------------------------------------------------------------
async function showSubs() {
	setTab("subs");
	if (!store.subs.length) {
		view.innerHTML = '<div class="note"><p>no subscriptions yet.</p><p class="dim" style="margin:0">hit subscribe on any watch page and that channel lands here, synced to your ramjet account.</p></div>';
		return;
	}
	const rows = store.subs.map((s) => `<div class="subrow">
		<a class="subname" href="#/s/${encodeURIComponent(s.name)}">${esc(s.name)}</a>
		<button class="plain" data-unsub="${esc(s.name)}">unsubscribe</button>
	</div>`).join("");
	view.innerHTML = `<h2 class="sec pad" style="padding-bottom:0">subscriptions</h2><div class="subs">${rows}</div><h2 class="sec pad" style="padding-bottom:0">latest from your channels</h2><div id="subsfeed">${skeleton()}</div>`;
	for (const b of document.querySelectorAll("[data-unsub]")) {
		b.addEventListener("click", () => { toggleSub(b.dataset.unsub); showSubs(); });
	}
	// latest: top videos per channel via search, merged, deduped
	try {
		const names = store.subs.slice(0, 8).map((s) => s.name);
		const results = await Promise.all(names.map((n) => api("search?q=" + encodeURIComponent(n)).catch(() => ({ items: [] }))));
		const seen = new Set();
		const merged = [];
		results.forEach((d, i) => {
			const want = names[i].toLowerCase();
			for (const it of d.items || []) {
				if ((it.uploader || "").toLowerCase() !== want) continue;
				if (seen.has(it.id)) continue;
				seen.add(it.id);
				merged.push(it);
				if (merged.filter((x) => (x.uploader || "").toLowerCase() === want).length >= 2) break;
			}
		});
		document.getElementById("subsfeed").innerHTML = grid(merged.slice(0, 24));
	} catch (e) {
		document.getElementById("subsfeed").innerHTML = '<p class="dim pad">the feed is rate-limited right now - try again in a bit.</p>';
	}
}

// -- settings ------------------------------------------------------------------
function showSettings() {
	setTab("settings");
	const s = store.settings;
	view.innerHTML = `<div class="pad">
		<h2 class="sec" style="padding:0 0 6px">settings</h2>
		<div class="setrow"><span>autoplay next video</span><input type="checkbox" id="set-autoplay"${s.autoplayNext ? " checked" : ""}></div>
		<div class="setrow"><span>resume where i left off</span><input type="checkbox" id="set-resume"${s.resume ? " checked" : ""}></div>
		<div class="setrow"><span>default quality</span><select class="quality" id="set-quality">
			<option value="auto"${s.quality === "auto" ? " selected" : ""}>auto</option>
			<option value="720p"${s.quality === "720p" ? " selected" : ""}>720p</option>
			<option value="360p"${s.quality === "360p" ? " selected" : ""}>360p</option>
		</select></div>
		<p class="dim" style="font-size:12.5px">synced to your ramjet account - same settings, history and subscriptions on every device.</p>
	</div>`;
	document.getElementById("set-autoplay").addEventListener("change", (e) => { store.settings.autoplayNext = e.target.checked; save(); });
	document.getElementById("set-resume").addEventListener("change", (e) => { store.settings.resume = e.target.checked; save(); });
	document.getElementById("set-quality").addEventListener("change", (e) => { store.settings.quality = e.target.value; save(); });
}

function route() {
	const h = location.hash || "#/";
	view.classList.remove("fade-in");
	void view.offsetWidth;
	view.classList.add("fade-in");
	if (h.startsWith("#/w/")) return showWatch(h.slice(4).split("?")[0]);
	if (h.startsWith("#/s/")) return showSearch(decodeURIComponent(h.slice(4)));
	if (h === "#/history") return showHistory();
	if (h === "#/subs") return showSubs();
	if (h === "#/settings") return showSettings();
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
loadRemote().then(() => { const h = location.hash || "#/"; if (h === "#/history" || h === "#/subs" || h === "#/settings") route(); });
