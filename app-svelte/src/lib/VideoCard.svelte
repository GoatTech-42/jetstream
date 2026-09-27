<script>
	export let it;
	export let style = "";
	import { fmtViews } from "./util.js";
	$: meta = it.metaText || [it.uploader, it.views ? fmtViews(it.views) : "", it.resume || ""].filter(Boolean).join(" · ");
</script>

<a class="card" href="#/w/{it.id}" {style}>
	<div class="thumbwrap">
		<img loading="lazy" src={it.thumb} alt="">
		{#if it.progressPct}<div class="watched"><div style="width:{Math.min(100, it.progressPct)}%"></div></div>{/if}
		{#if it.short}<span class="dur">short</span>
		{:else if it.live}<span class="dur live">live</span>
		{:else if it.dur}<span class="dur">{it.dur}</span>{/if}
	</div>
	<p class="ctitle">{it.title}</p>
	<p class="cmeta">{meta}</p>
</a>
