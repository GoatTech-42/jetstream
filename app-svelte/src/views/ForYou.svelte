<script>
	import { onMount } from "svelte";
	import { api, prefetch } from "../lib/api.js";
	import { store, rankItems } from "../lib/store.js";
	import { idle } from "../lib/util.js";
	import VideoCard from "../lib/VideoCard.svelte";
	import SkelGrid from "../lib/SkelGrid.svelte";
	import Sentinel from "../lib/Sentinel.svelte";

	let items = null;      // null = loading
	let empty = null;      // 'cold' | 'warm'
	let expanding = 0, busy = false;
	let have = new Set();

	// continue watching: anything with a resume point worth showing
	$: resumeRail = $store.history
		.filter((h) => { const p = $store.progress[h.id]; return p && h.durSec && p > 10 && p < h.durSec - 15; })
		.slice(0, 10)
		.map((h) => ({ ...h, resume: "resume " + Math.floor($store.progress[h.id] / 60) + ":" + String($store.progress[h.id] % 60).padStart(2, "0"), progressPct: Math.round(($store.progress[h.id] / h.durSec) * 100) }));

	async function pool() {
		const s = $store;
		const out = [];
		const seen = new Set();
		const add = (arr) => { for (const it of arr || []) { if (it && it.id && !seen.has(it.id)) { seen.add(it.id); out.push(it); } } };
		const names = s.subs.slice(0, 8).map((x) => x.name);
		if (names.length) {
			const results = await Promise.all(names.map((n) => api("search?q=" + encodeURIComponent(n)).catch(() => ({ items: [] }))));
			results.forEach((d, i) => {
				const want = names[i].toLowerCase();
				let took = 0;
				for (const it of d.items || []) {
					if ((it.uploader || "").toLowerCase() !== want) continue;
					add([it]);
					if (++took >= 3) break;
				}
			});
		}
		for (const h of s.history.slice(0, 2)) {
			try { const w = await api("watch?v=" + encodeURIComponent(h.id)); add((w.related || []).slice(0, 6)); } catch (e) {}
		}
		return out;
	}

	async function load() {
		const watched = new Set($store.history.map((h) => h.id));
		const p = (await pool()).filter((it) => !watched.has(it.id));
		if (!p.length) { empty = $store.subs.length ? "warm" : "cold"; items = []; return; }
		items = $store.settings.algo ? rankItems($store, p) : p;
		have = new Set(items.map((x) => x.id));
		idle(() => items.slice(0, 3).forEach((it, i) => setTimeout(() => prefetch("watch?v=" + it.id), i * 900)));
	}

	async function expand() {
		if (busy || expanding >= 12 || !items) return;
		const nextHist = $store.history.slice(2 + expanding);
		if (!nextHist.length) return;
		busy = true; expanding++;
		try {
			const fresh = [];
			for (const h of nextHist.slice(0, 2)) {
				try { const w = await api("watch?v=" + encodeURIComponent(h.id)); fresh.push(...(w.related || [])); } catch (e) {}
			}
			const watched = new Set($store.history.map((h) => h.id));
			const add = fresh.filter((it) => it && it.id && !watched.has(it.id) && !have.has(it.id));
			add.forEach((it) => have.add(it.id));
			if (add.length) items = [...items, ...($store.settings.algo ? rankItems($store, add) : add)];
		} catch (e) {}
		busy = false;
	}

	onMount(load);
</script>

<div class="viewfade">
{#if resumeRail.length}
	<div class="sec"><h2>continue watching</h2></div>
	<div class="rail">
		{#each resumeRail as it (it.id)}<VideoCard {it} />{/each}
	</div>
{/if}
{#if items === null}
	<SkelGrid />
{:else if empty}
	<div class="note">
		{#if empty === "cold"}
			<p>your feed builds itself.</p>
			<p class="dim">subscribe to channels and watch a few things - this page becomes videos picked for you.</p>
		{:else}
			<p>your feed is warming up.</p>
			<p class="dim">the upstream is busy right now - try again in a bit.</p>
		{/if}
	</div>
{:else}
	{#if resumeRail.length}<div class="sec"><h2>picked for you</h2></div>{/if}
	<div class="grid">
		{#each items as it, i (it.id)}<VideoCard {it} style="animation-delay:{Math.min(i, 12) * 30}ms" />{/each}
	</div>
	{#if expanding < 12}<Sentinel on:reach={expand} />{/if}
{/if}
</div>
