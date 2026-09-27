<script>
	import { onMount } from "svelte";
	import { api, prefetch } from "../lib/api.js";
	import { store, rankItems } from "../lib/store.js";
	import { idle } from "../lib/util.js";
	import VideoCard from "../lib/VideoCard.svelte";
	import SkelGrid from "../lib/SkelGrid.svelte";

	let items = null, extra = [], err = "", liveNote = false;

	async function load() {
		try {
			const d = await api("trending");
			let its = $store.settings.algo ? rankItems($store, d.items || []) : (d.items || []);
			if (its.length >= 8) {
				items = its;
				idle(() => its.slice(0, 3).forEach((it, i) => setTimeout(() => prefetch("watch?v=" + it.id), i * 900)));
				return;
			}
			// live-heavy night: top up from his own feed - the page is never empty
			liveNote = true;
			const watched = new Set($store.history.map((h) => h.id));
			const have = new Set(its.map((x) => x.id));
			// small inline foryou pool (subs-based), same rules as ForYou
			const names = $store.subs.slice(0, 8).map((x) => x.name);
			const p = [];
			const seen = new Set();
			if (names.length) {
				const results = await Promise.all(names.map((n) => api("search?q=" + encodeURIComponent(n)).catch(() => ({ items: [] }))));
				results.forEach((dd, i) => {
					const want = names[i].toLowerCase();
					let took = 0;
					for (const it of dd.items || []) {
						if ((it.uploader || "").toLowerCase() !== want || seen.has(it.id)) continue;
						seen.add(it.id); p.push(it);
						if (++took >= 3) break;
					}
				});
			}
			const poolX = p.filter((it) => !watched.has(it.id) && !have.has(it.id));
			extra = ($store.settings.algo ? rankItems($store, poolX) : poolX).slice(0, 16);
			items = its;
			if (!its.length && !extra.length) { err = "empty"; }
		} catch (e) { err = "fail"; }
	}
	onMount(load);
</script>

<div class="viewfade">
{#if items === null}
	<SkelGrid />
{:else if err === "fail"}
	<div class="note"><p>trending won't load right now - the upstream is probably rate-limited.</p><button class="btn" on:click={() => { items = null; err = ""; load(); }}>retry</button></div>
{:else if err === "empty"}
	<div class="note"><p>trending is all live right now and lives can't play here yet.</p><p class="dim">search works meanwhile - or subscribe to a channel and your for-you tab takes over.</p></div>
{:else}
	{#if !items.length && liveNote}<p class="dim pad" style="padding-bottom:0">trending is wall-to-wall live right now - lives stay hidden since they can't play here.</p>{/if}
	{#if items.length}<div class="grid">{#each items as it, i (it.id)}<VideoCard {it} style="animation-delay:{Math.min(i, 12) * 30}ms" />{/each}</div>{/if}
	{#if extra.length}<div class="sec"><h2>meanwhile, for you</h2></div><div class="grid">{#each extra as it (it.id)}<VideoCard {it} />{/each}</div>{/if}
{/if}
</div>
