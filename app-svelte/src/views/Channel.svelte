<script>
	import { onMount } from "svelte";
	import { api, prefetch } from "../lib/api.js";
	import { store, isSubbed, toggleSub, startQueue } from "../lib/store.js";
	import { idle } from "../lib/util.js";
	import VideoCard from "../lib/VideoCard.svelte";
	import ShortCard from "../lib/ShortCard.svelte";
	import SkelGrid from "../lib/SkelGrid.svelte";
	import Sentinel from "../lib/Sentinel.svelte";

	export let id = "";
	let d = null, err = false;
	let tab = "videos";
	let cont = "", busy = false, vids = [];
	let have = new Set();

	$: subbed = d ? isSubbed($store, d.name) : false;

	async function load() {
		try {
			d = await api("channel?id=" + encodeURIComponent(id));
			vids = d.videos || [];
			cont = d.continuation || "";
			have = new Set(vids.map((x) => x.id));
			if (!vids.length && (d.shorts || []).length) tab = "shorts";
			else if (!vids.length && !(d.shorts || []).length && (d.playlists || []).length) tab = "playlists";
			if (vids.length) idle(() => setTimeout(() => prefetch("watch?v=" + vids[0].id), 600));
		} catch (e) { err = true; }
	}
	async function more() {
		if (busy || !cont) return;
		busy = true;
		try {
			const d2 = await api("channel?id=" + encodeURIComponent(id) + "&cont=" + encodeURIComponent(cont));
			cont = d2.continuation || "";
			const fresh = (d2.videos || []).filter((it) => it && it.id && !have.has(it.id));
			fresh.forEach((it) => have.add(it.id));
			if (fresh.length) vids = [...vids, ...fresh];
		} catch (e) {}
		busy = false;
	}
	function sub() { toggleSub(d.name, d.id || ""); }
	onMount(load);
</script>

<div class="viewfade">
{#if !d && !err}
	<SkelGrid />
{:else if err}
	<div class="note"><p>couldn't load that channel.</p><button class="btn" on:click={() => { err = false; load(); }}>retry</button></div>
{:else}
	<div class="chhead2">
		{#if d.avatar}<img class="chavatar2" src={d.avatar} alt="">{/if}
		<div class="chinfo2">
			<p class="chname2">{d.name}</p>
			<p class="chmeta2">{[d.subs, d.vidCount ? d.vidCount + " videos" : ""].filter(Boolean).join(" · ")}</p>
			{#if d.description}<button class="chdesc2" on:click={() => (tab = "about")}>{d.description}</button>{/if}
			<div class="chactions">
				<button class="pill2" class:subbed on:click={sub}>{subbed ? "subscribed" : "subscribe"}</button>
				{#if vids.length}<button class="pill2 ghost" on:click={() => startQueue(d.name, vids)}>
					<svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>play all</button>{/if}
			</div>
		</div>
	</div>
	<div class="chtabs">
		{#if vids.length}<button class="chtab" class:on={tab === "videos"} on:click={() => (tab = "videos")}>videos</button>{/if}
		{#if (d.shorts || []).length}<button class="chtab" class:on={tab === "shorts"} on:click={() => (tab = "shorts")}>shorts</button>{/if}
		{#if (d.playlists || []).length}<button class="chtab" class:on={tab === "playlists"} on:click={() => (tab = "playlists")}>playlists</button>{/if}
		{#if d.description}<button class="chtab" class:on={tab === "about"} on:click={() => (tab = "about")}>about</button>{/if}
	</div>

	{#if tab === "videos"}
		{#if vids.length}
			<div class="grid">{#each vids as it, i (it.id)}<VideoCard {it} style="animation-delay:{Math.min(i, 12) * 25}ms" />{/each}</div>
			{#if cont}<Sentinel on:reach={more} />{/if}
		{:else if !(d.shorts || []).length}
			<p class="dim pad">no videos found on this channel.</p>
		{/if}
	{:else if tab === "shorts"}
		<div class="sgrid">{#each d.shorts as it (it.id)}<ShortCard {it} />{/each}</div>
	{:else if tab === "playlists"}
		<div class="plrow">
			{#each d.playlists as pl (pl.id)}
				<a class="plcard" href="#/p/{pl.id}">
					{#if pl.thumb}<img loading="lazy" src={pl.thumb} alt="">{/if}
					<span class="plinfo"><b>{pl.title}</b><span class="dim">playlist</span></span>
				</a>
			{/each}
		</div>
	{:else if tab === "about"}
		<div class="desc" style="margin-top:16px"><pre>{d.description}</pre></div>
	{/if}
{/if}
</div>
