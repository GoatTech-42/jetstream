<script>
	import { onMount } from "svelte";
	import { api, prefetch } from "../lib/api.js";
	import { startQueue } from "../lib/store.js";
	import { idle } from "../lib/util.js";
	import SkelGrid from "../lib/SkelGrid.svelte";

	export let id = "";
	let d = null, err = false;
	async function load() {
		try {
			d = await api("playlist?id=" + encodeURIComponent(id));
			if ((d.videos || []).length) idle(() => setTimeout(() => prefetch("watch?v=" + d.videos[0].id), 600));
		} catch (e) { err = true; }
	}
	onMount(load);
</script>

<div class="viewfade">
{#if !d && !err}
	<SkelGrid />
{:else if err}
	<div class="note"><p>couldn't load that playlist.</p><button class="btn" on:click={() => { err = false; load(); }}>retry</button></div>
{:else}
	<div class="pad">
		<h2 style="margin:0 0 4px;font-size:22px;font-weight:800;letter-spacing:-.01em">{d.title}</h2>
		<p class="dim" style="margin:0 0 12px">playlist · {(d.videos || []).length} videos</p>
		{#if (d.videos || []).length}<button class="btn amber" on:click={() => startQueue(d.title, d.videos)}>play all</button>{/if}
	</div>
	{#if (d.videos || []).length}
		<div class="pllist">
			{#each d.videos as it, i (it.id)}
				<a class="plitem" href="#/w/{it.id}">
					<span class="plnum">{i + 1}</span>
					<img loading="lazy" src={it.thumb} alt="">
					<span class="pliteminfo"><b>{it.title}</b><span class="dim">{it.metaText || it.dur || ""}</span></span>
				</a>
			{/each}
		</div>
	{:else}
		<p class="dim pad">this playlist looks empty.</p>
	{/if}
{/if}
</div>
