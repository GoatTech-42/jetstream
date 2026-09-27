<script>
	import { store, removeLater, wipeHistory } from "../lib/store.js";
	import VideoCard from "../lib/VideoCard.svelte";

	$: items = $store.history.map((h) => {
		const p = $store.progress[h.id];
		return {
			...h,
			resume: p && h.durSec && p < h.durSec - 15 ? "resume " + Math.floor(p / 60) + ":" + String(p % 60).padStart(2, "0") : "",
			progressPct: p && h.durSec ? Math.round((p / h.durSec) * 100) : 0,
		};
	});
</script>

<div class="viewfade">
{#if $store.later.length}
	<div class="sec"><h2>watch later ({$store.later.length})</h2></div>
	<div class="subs">
		{#each $store.later as v (v.id)}
			<div class="subrow">
				<a class="subname" href="#/w/{v.id}">{v.title}</a>
				<button class="btn" on:click={() => removeLater(v.id)}>remove</button>
			</div>
		{/each}
	</div>
{/if}
{#if items.length}
	<div class="sec"><h2>watch history</h2></div>
	<div class="grid">{#each items as it (it.id)}<VideoCard {it} />{/each}</div>
	<div class="pad"><button class="btn" on:click={wipeHistory}>clear history</button></div>
{:else if !$store.later.length}
	<p class="dim pad">nothing watched yet.</p>
{/if}
</div>
