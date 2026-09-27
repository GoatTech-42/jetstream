// per-user store: history, resume points, settings, subs, watch-later.
// syncs through ramjet's encrypted blob under the "jetstream" key,
// localStorage fallback when sync is locked or off.
import { writable, get } from "svelte/store";

const LS_KEY = "jetstream-store";
export const DEFAULT_SETTINGS = { autoplayNext: true, resume: true, quality: "auto", algo: true, clearOnExit: false };

function blank() { return { history: [], progress: {}, settings: { ...DEFAULT_SETTINGS }, subs: [], later: [] }; }
function norm(s) {
	if (!s || typeof s !== "object") return blank();
	return {
		history: s.history || [],
		progress: s.progress || {},
		settings: { ...DEFAULT_SETTINGS, ...(s.settings || {}) },
		subs: Array.isArray(s.subs) ? s.subs : [],
		later: Array.isArray(s.later) ? s.later : [],
	};
}

export const store = writable(blank());
// play-all queue (channel pages, playlists) - lives only in this page session
export const queue = writable(null); // { label, items: [{id,title,...}] }
export const rjLowData = writable(false);

let saveQueued = false;
function persist() {
	const s = get(store);
	try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) {}
	if (saveQueued) return;
	saveQueued = true;
	setTimeout(async () => {
		saveQueued = false;
		if (typeof RJCrypto === "undefined" || !RJCrypto.unlocked()) return;
		try {
			const blob = (await RJCrypto.pull()) || {};
			const c = get(store);
			blob.jetstream = { history: c.history.slice(0, 40), progress: c.progress, settings: c.settings, subs: c.subs, later: c.later.slice(0, 60) };
			await RJCrypto.push(blob);
		} catch (e) {}
	}, 1200);
}

export function loadLocal() {
	try { store.set(norm(JSON.parse(localStorage.getItem(LS_KEY) || "null"))); } catch (e) {}
}
export async function loadRemote() {
	if (typeof RJCrypto === "undefined") return;
	try {
		if (!RJCrypto.unlocked()) await RJCrypto.tryRestore();
		if (!RJCrypto.unlocked()) return;
		const blob = await RJCrypto.pull();
		if (blob && blob.jetstream) {
			const s = norm(blob.jetstream);
			store.set(s);
			try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) {}
		}
	} catch (e) {}
}

export function pushHistory(it) {
	store.update((s) => {
		let h = s.history.filter((x) => x.id !== it.id);
		h.unshift({ id: it.id, title: it.title, uploader: it.uploader, thumb: it.thumb, dur: it.dur, durSec: it.durSec, at: Date.now() });
		return { ...s, history: h.slice(0, 40) };
	});
	persist();
}
export function setProgress(id, seconds) {
	if (!id || !isFinite(seconds) || seconds < 5) return;
	store.update((s) => ({ ...s, progress: { ...s.progress, [id]: Math.floor(seconds) } }));
	persist();
}
export const isSubbed = (s, name) => s.subs.some((x) => x.name.toLowerCase() === String(name || "").toLowerCase());
export function toggleSub(name, chId) {
	store.update((s) => {
		const subs = isSubbed(s, name)
			? s.subs.filter((x) => x.name.toLowerCase() !== String(name).toLowerCase())
			: [{ name, chId: chId || "", at: Date.now() }, ...s.subs];
		return { ...s, subs };
	});
	persist();
}
export const isLater = (s, id) => s.later.some((x) => x.id === id);
export function toggleLater(v) {
	store.update((s) => {
		const later = isLater(s, v.id)
			? s.later.filter((x) => x.id !== v.id)
			: [{ id: v.id, title: v.title, uploader: v.uploader || "", thumb: v.thumb || "", dur: v.dur || "", at: Date.now() }, ...s.later];
		return { ...s, later };
	});
	persist();
}
export function removeLater(id) { store.update((s) => ({ ...s, later: s.later.filter((x) => x.id !== id) })); persist(); }
export function setSetting(k, v) { store.update((s) => ({ ...s, settings: { ...s.settings, [k]: v } })); persist(); }
export function wipeHistory() { store.update((s) => ({ ...s, history: [], progress: {} })); persist(); }

// jetstream's own ranking: subs + watch-history signal. off = plain order.
export function rankItems(s, items) {
	const subbed = new Set(s.subs.map((x) => x.name.toLowerCase()));
	const histU = new Map();
	const seen = new Set();
	for (const h of s.history) {
		const u = (h.uploader || "").toLowerCase();
		if (u) histU.set(u, (histU.get(u) || 0) + 1);
		seen.add(h.id);
	}
	return items.map((it, i) => {
		const u = (it.uploader || "").toLowerCase();
		let score = 0;
		if (subbed.has(u)) score += 6;
		score += Math.min(4, histU.get(u) || 0);
		if (seen.has(it.id)) score -= 8;
		return [score, i, it];
	}).sort((a, b) => b[0] - a[0] || a[1] - b[1]).map((x) => x[2]);
}

export function startQueue(label, items) {
	if (!items || !items.length) return;
	queue.set({ label, items });
	location.hash = "#/w/" + items[0].id;
}
export function queueNext(q, id) {
	if (!q) return null;
	const i = q.items.findIndex((x) => x.id === id);
	if (i < 0 || i + 1 >= q.items.length) return null;
	return q.items[i + 1];
}

// -- theme: follow ramjet's own theme ------------------------------------------
const RJ_THEMES = { amber: ["#ffa028", "#c96f04"], mint: ["#34d399", "#059669"], sky: ["#38bdf8", "#0369a1"], violet: ["#a78bfa", "#6d28d9"], ember: ["#f87171", "#b91c1c"] };
function rjShade(hex, amt) {
	const n = parseInt(hex.slice(1), 16);
	const ch = (v) => Math.max(0, Math.min(255, Math.round(v * (1 + amt))));
	return "#" + [ch(n >> 16), ch((n >> 8) & 255), ch(n & 255)].map((v) => v.toString(16).padStart(2, "0")).join("");
}
export function applyRamjetTheme() {
	let s = null;
	try { s = JSON.parse(localStorage.getItem("rj.settings") || "null"); } catch (e) {}
	let pair = RJ_THEMES.amber;
	if (s && typeof s === "object") {
		rjLowData.set(!!s.lowData);
		if (s.theme === "custom") {
			const a = /^#[0-9a-fA-F]{6}$/.test(s.customAccent || "") ? s.customAccent : "#ffa028";
			pair = [a, rjShade(a, -0.35)];
		} else if (RJ_THEMES[s.theme]) pair = RJ_THEMES[s.theme];
	}
	document.documentElement.style.setProperty("--amber", pair[0]);
	document.documentElement.style.setProperty("--amber-deep", pair[1]);
}

export function wipeHistoryOnExit() {
	const s = get(store);
	if (!s.settings.clearOnExit) return;
	store.update((x) => ({ ...x, history: [], progress: {} }));
	try { localStorage.setItem(LS_KEY, JSON.stringify(get(store))); } catch (e) {}
	if (typeof RJCrypto !== "undefined" && RJCrypto.unlocked()) {
		RJCrypto.pull().then((blob) => {
			blob = blob || {};
			blob.jetstream = { history: [], progress: {}, settings: s.settings, subs: s.subs, later: s.later.slice(0, 60) };
			RJCrypto.push(blob).catch(() => {});
		}).catch(() => {});
	}
}
