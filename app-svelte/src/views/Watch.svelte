<script context="module">
	const commentsCache = {};
</script>

<script>
	import { onMount } from "svelte";
	import { api, prefetch } from "../lib/api.js";
	import { store, queue, rankItems, pushHistory, isSubbed, toggleSub, isLater, toggleLater, queueNext, rjLowData } from "../lib/store.js";
	import { idle, fmtViews, fmtLikes } from "../lib/util.js";
	import Player from "../lib/Player.svelte";
	import VideoCard from "../lib/VideoCard.svelte";

	export let id = "";
	let d = null, err = false;
	let resume = 0, startIdx = 0, hasStreams = false;
	let comments = null, commentsErr = false, commentsOpen = false;
	let commentCount = "", likeMeta = "";
	let cmtDetails;

	$: subbed = d ? isSubbed($store, d.uploader) : false;
	$: later = d ? isLater($store, d.id) : false;
	$: rel = d ? ($store.settings.algo ? rankItems($store, d.related || []) : (d.related || [])) : [];
	$: qIdx = d && $queue ? $queue.items.findIndex((x) => x.id === d.id) : -1;

	function fetchComments(vid) {
		if (!commentsCache[vid]) commentsCache[vid] = api("comments?v=" + encodeURIComponent(vid)).catch(() => null);
		return commentsCache[vid];
	}
	async function fillComments() {
		const data = await fetchComments(d.id);
		if (!data) { commentsErr = true; comments = []; return; }
		comments = data.comments || [];
		if (data.count) commentCount = "comments (" + data.count + ")";
		if (data.likes) likeMeta = " · " + fmtLikes(data.likes) + " likes";
	}
	function toggleComments() {
		commentsOpen = cmtDetails.open;
		if (commentsOpen && comments === null) fillComments();
	}

	async function load() {
		try {
			d = await api("watch?v=" + encodeURIComponent(id));
		} catch (e) { err = true; return; }
		pushHistory({ id: d.id, title: d.title, uploader: d.uploader, thumb: d.thumb || "", dur: d.dur, durSec: d.durSec });
		resume = $store.settings.resume ? ($store.progress[d.id] || 0) : 0;
		const prog = (d.streams || []).map((x) => ({ q: x.q, src: x.src, hd: false }));
		const hdv = (d.hd && d.hd.videos ? d.hd.videos : []).map((x) => ({ q: x.q, src: x.src, hd: true }));
		const seenQ = new Set();
		const qualities = hdv.concat(prog).filter((x) => { if (seenQ.has(x.q)) return false; seenQ.add(x.q); return true; });
		d._qualities = qualities;
		d._hdAudio = d.hd && d.hd.audio ? d.hd.audio : null;
		hasStreams = qualities.length > 0 && (!hdv.length || d._hdAudio);
		startIdx = 0;
		if (hasStreams) {
			if ($store.settings.quality !== "auto") {
				const qi = qualities.findIndex((x) => x.q === $store.settings.quality);
				if (qi >= 0) startIdx = qi;
			} else {
				const qi = qualities.findIndex((x) => x.q === "1080p");
				startIdx = qi >= 0 ? qi : 0;
			}
		}
		d._startIdx = startIdx;
		// warm what he's likely to tap next
		idle(() => {
			const nxt = queueNext($queue, d.id) || ((d.related || [])[0]);
			if (nxt) prefetch("watch?v=" + nxt.id);
			if (d.chId) setTimeout(() => prefetch("channel?id=" + encodeURIComponent(d.chId)), 900);
			if (!$rjLowData) setTimeout(() => fetchComments(d.id).then((c) => {
				if (!c) return;
				if (c.count) commentCount = "comments (" + c.count + ")";
				if (c.likes) likeMeta = " · " + fmtLikes(c.likes) + " likes";
				if (commentsOpen) fillComments();
			}), 1600);
		});
	}
	function sub() { toggleSub(d.uploader, d.chId || ""); }
	function laterBtn() { toggleLater({ id: d.id, title: d.title, uploader: d.uploader, thumb: d.thumb || "", dur: d.dur }); }
	onMount(load);
	$: metaBits = d ? [fmtViews(d.views), d.uploaded ? d.uploaded.slice(0, 10) : "", d.likes ? fmtLikes(d.likes) + " likes" : ""].filter(Boolean).join(" · ") : "";
</script>

{#if !d && !err}
	<div class="watchwrap" style="padding-top:14px"><div style="padding:0 16px"><div class="skel-player"></div><div class="skel-line"></div><div class="skel-line short"></div></div></div>
{:else if err}
	<div class="note"><p>couldn't load that video.</p><button class="btn" on:click={() => { err = false; load(); }}>retry</button></div>
{:else}
<div class="watchcols viewfade">
	<div class="watchwrap">
		{#if hasStreams}
			<Player {d} {resume} />
		{:else}
			<div class="note">{d.live ? "this one's live - live playback isn't supported yet." : "no playable stream for this video."}</div>
		{/if}
		{#if qIdx >= 0}<p class="qchip">playing all · {$queue.label} · {qIdx + 1}/{$queue.items.length}</p>{/if}
		<p class="wtitle">{d.title}</p>
		<div class="wsubrow">
			<p class="wmeta"><a class="uplink" href={d.chId ? "#/c/" + encodeURIComponent(d.chId) : "#/s/" + encodeURIComponent(d.uploader)}>{d.uploader}</a>{metaBits ? " · " + metaBits : ""}{likeMeta}</p>
			<button class="btn" on:click={laterBtn}>{later ? "saved" : "later"}</button>
			<button class="btn amber" class:on={subbed} on:click={sub}>{subbed ? "subscribed" : "subscribe"}</button>
		</div>
		{#if d.description}
			<details class="desc"><summary>description</summary><pre>{d.description}</pre></details>
		{/if}
		{#if hasStreams}
			<details class="desc" bind:this={cmtDetails} on:toggle={toggleComments}>
				<summary>{commentCount || "comments"}</summary>
				<div class="cmts">
					{#if comments === null}
						<p class="dim" style="margin:6px 2px">loading comments...</p>
					{:else if commentsErr}
						<p class="dim" style="margin:6px 2px">comments won't load right now.</p>
					{:else if !comments.length}
						<p class="dim" style="margin:6px 2px">no comments on this one.</p>
					{:else}
						{#each comments as c, i}
							<div class="cmt" style="animation-delay:{Math.min(i, 10) * 30}ms">
								{#if c.avatar}<img class="cmtavatar" loading="lazy" src={c.avatar} alt="">{:else}<span class="cmtavatar"></span>{/if}
								<div class="cmtbody">
									<p class="cmtmeta"><b>{c.author}</b>{#if c.pinned}<span class="cmtpin">pinned</span>{/if} <span class="dim">{[c.time, c.likes].filter(Boolean).join(" · ")}</span></p>
									<p class="cmttext">{c.text}</p>
								</div>
							</div>
						{/each}
					{/if}
				</div>
			</details>
		{/if}
	</div>
	{#if rel.length}
		<div class="railcol">
			<div class="sec"><h2>up next</h2></div>
			<div class="grid">{#each rel as it, i (it.id)}<VideoCard {it} style="animation-delay:{Math.min(i, 12) * 30}ms" />{/each}</div>
		</div>
	{/if}
</div>
{/if}
