<script>
	import { onMount } from "svelte";
	import { api } from "../lib/api.js";
	import { fmtViews } from "../lib/util.js";
	import VideoCard from "../lib/VideoCard.svelte";
	import ShortCard from "../lib/ShortCard.svelte";
	import SkelGrid from "../lib/SkelGrid.svelte";
	import Sentinel from "../lib/Sentinel.svelte";

	export let q = "";
	const FILTERS = ["videos", "shorts", "channels", "playlists"];
	let f = "videos";
	let items = null, err = false;
	let cont = "", busy = false;

	async function load() {
		items = null; err = false; cont = "";
		try {
			if (f === "videos") {
				const d = await api("search?q=" + encodeURIComponent(q));
				items = d.items || [];
				cont = d.continuation || "";
			} else if (f === "shorts") {
				const d = await api("search?q=" + encodeURIComponent(q) + "&filter=shorts");
				items = d.items || [];
			} else if (f === "channels") {
				const d = await api("search-channels?q=" + encodeURIComponent(q));
				items = (d && d.items) || [];
			} else {
				const d = await api("search-playlists?q=" + encodeURIComponent(q));
				items = (d && d.items) || [];
			}
		} catch (e) { err = true; items = []; }
	}
	async function more() {
		if (busy || !cont) return;
		busy = true;
		try {
			const d = await api("search?q=" + encodeURIComponent(q) + "&cont=" + encodeURIComponent(cont));
			cont = d.continuation || "";
			if (d.items && d.items.length) items = [...items, ...d.items];
		} catch (e) {}
		busy = false;
	}
	function pick(x) { if (x !== f) { f = x; load(); } }
	onMount(load);
</script>

<div class="viewfade">
<div class="sec"><h2>results for "{q}"</h2></div>
<div class="fchips">
	{#each FILTERS as x}<button class="fchip" class:on={f === x} on:click={() => pick(x)}>{x}</button>{/each}
</div>
{#if items === null}
	<SkelGrid />
{:else if err}
	<p class="dim pad">that search failed - try again.</p>
{:else if !items.length}
	<p class="dim pad">no {f} matched that.</p>
{:else if f === "videos"}
	<div class="grid">{#each items as it (it.id)}<VideoCard {it} />{/each}</div>
	{#if cont}<Sentinel on:reach={more} />{/if}
{:else if f === "shorts"}
	<div class="sgrid">{#each items as it (it.id)}<ShortCard {it} />{/each}</div>
{:else if f === "channels"}
	<div class="plrow">
		{#each items as c (c.id)}
			<a class="plcard" href="#/c/{c.id}">
				{#if c.avatar}<img loading="lazy" class="round" src={c.avatar} alt="">{/if}
				<span class="plinfo"><b>{c.name}</b><span class="dim">{c.subs > 0 ? fmtViews(c.subs).replace("views", "subscribers") : "channel"}{c.description ? " · " + c.description : ""}</span></span>
			</a>
		{/each}
	</div>
{:else}
	<div class="plrow">
		{#each items as pl (pl.id)}
			<a class="plcard" href="#/p/{pl.id}">
				{#if pl.thumb}<img loading="lazy" src={pl.thumb} alt="">{/if}
				<span class="plinfo"><b>{pl.title}</b><span class="dim">playlist{pl.count ? " · " + pl.count + " videos" : ""}{pl.uploader ? " · " + pl.uploader : ""}</span></span>
			</a>
		{/each}
	</div>
{/if}
</div>
