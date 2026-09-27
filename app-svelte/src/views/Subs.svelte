<script>
	import { onMount } from "svelte";
	import { api } from "../lib/api.js";
	import { store, toggleSub } from "../lib/store.js";
	import VideoCard from "../lib/VideoCard.svelte";
	import SkelGrid from "../lib/SkelGrid.svelte";

	let feed = null, feedErr = false;
	$: subLink = (s) => (s.chId ? "#/c/" + encodeURIComponent(s.chId) : "#/s/" + encodeURIComponent(s.name));

	async function loadFeed() {
		try {
			const names = $store.subs.slice(0, 8).map((s) => s.name);
			const results = await Promise.all(names.map((n) => api("search?q=" + encodeURIComponent(n)).catch(() => ({ items: [] }))));
			const seen = new Set();
			const merged = [];
			results.forEach((d, i) => {
				const want = names[i].toLowerCase();
				for (const it of d.items || []) {
					if ((it.uploader || "").toLowerCase() !== want || seen.has(it.id)) continue;
					seen.add(it.id);
					merged.push(it);
					if (merged.filter((x) => (x.uploader || "").toLowerCase() === want).length >= 2) break;
				}
			});
			feed = merged.slice(0, 24);
		} catch (e) { feedErr = true; feed = []; }
	}
	onMount(() => { if ($store.subs.length) loadFeed(); });
</script>

<div class="viewfade">
{#if !$store.subs.length}
	<div class="note"><p>no subscriptions yet.</p><p class="dim">hit subscribe on any watch page and that channel lands here, synced to your ramjet account.</p></div>
{:else}
	<div class="sec"><h2>subscriptions</h2></div>
	<div class="subs">
		{#each $store.subs as s (s.name)}
			<div class="subrow">
				<a class="subname" href={subLink(s)}>{s.name}</a>
				<button class="btn" on:click={() => toggleSub(s.name)}>unsubscribe</button>
			</div>
		{/each}
	</div>
	<div class="sec"><h2>latest from your channels</h2></div>
	{#if feed === null}
		<SkelGrid n={4} />
	{:else if feedErr}
		<p class="dim pad">the feed is rate-limited right now - try again in a bit.</p>
	{:else}
		<div class="grid">{#each feed as it (it.id)}<VideoCard {it} />{/each}</div>
	{/if}
{/if}
</div>
