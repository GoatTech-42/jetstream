<script>
	import { onMount } from "svelte";
	import { store, loadLocal, loadRemote, applyRamjetTheme, wipeHistoryOnExit } from "./lib/store.js";
	import { api } from "./lib/api.js";
	import { routeUrl } from "./lib/util.js";
	import { ICON } from "./lib/icons.js";
	import ForYou from "./views/ForYou.svelte";
	import Trending from "./views/Trending.svelte";
	import Search from "./views/Search.svelte";
	import Channel from "./views/Channel.svelte";
	import Playlist from "./views/Playlist.svelte";
	import Watch from "./views/Watch.svelte";
	import History from "./views/History.svelte";
	import Subs from "./views/Subs.svelte";
	import Settings from "./views/Settings.svelte";

	let hash = location.hash || "#/";
	let q = "";
	let sugs = [], sugActive = -1, sugOpen = false, sugTimer = null, lastQ = "";

	$: route = parse(hash);
	function parse(h) {
		if (h.startsWith("#/w/")) return { name: "watch", id: h.slice(4).split("?")[0] };
		if (h.startsWith("#/c/")) return { name: "channel", id: h.slice(4).split("?")[0] };
		if (h.startsWith("#/p/")) return { name: "playlist", id: h.slice(4).split("?")[0] };
		if (h.startsWith("#/s/")) return { name: "search", q: decodeURIComponent(h.slice(4)) };
		if (h === "#/trending") return { name: "trending" };
		if (h === "#/history") return { name: "history" };
		if (h === "#/subs") return { name: "subs" };
		if (h === "#/settings") return { name: "settings" };
		return { name: "foryou" };
	}
	function onHash() {
		hash = location.hash || "#/";
		q = route.name === "search" ? route.q : q;
		window.scrollTo(0, 0);
	}
	const NAV = [
		{ name: "foryou", label: "for you", href: "#/", icon: "home" },
		{ name: "trending", label: "trending", href: "#/trending", icon: "fire" },
		{ name: "subs", label: "subs", href: "#/subs", icon: "subs" },
		{ name: "history", label: "history", href: "#/history", icon: "clock" },
		{ name: "settings", label: "settings", href: "#/settings", icon: "gear" },
	];

	function submit() {
		const query = q.trim();
		if (!query) return;
		sugOpen = false;
		const direct = routeUrl(query);
		location.hash = direct || "#/s/" + encodeURIComponent(query);
	}
	function onInput() {
		clearTimeout(sugTimer);
		const query = q.trim();
		if (query.length < 2) { sugOpen = false; return; }
		sugTimer = setTimeout(async () => {
			try {
				const d = await api("suggest?q=" + encodeURIComponent(query));
				if (q.trim() !== query) return;
				lastQ = query; sugs = (d.items || []).slice(0, 6); sugActive = -1;
				sugOpen = sugs.length > 0;
			} catch (e) {}
		}, 180);
	}
	function onKey(e) {
		if (!sugOpen) return;
		if (e.key === "ArrowDown") { e.preventDefault(); sugActive = Math.min(sugs.length - 1, sugActive + 1); q = sugs[sugActive]; }
		else if (e.key === "ArrowUp") { e.preventDefault(); sugActive = Math.max(-1, sugActive - 1); if (sugActive >= 0) q = sugs[sugActive]; }
		else if (e.key === "Enter" && sugActive >= 0) { e.preventDefault(); pick(sugs[sugActive]); }
		else if (e.key === "Escape") sugOpen = false;
	}
	function pick(t) { q = t; sugOpen = false; submit(); }

	onMount(() => {
		applyRamjetTheme();
		loadLocal();
		loadRemote().then(() => {
			const h = location.hash || "#/";
			if (["#/", "#/foryou", "#/trending", "#/history", "#/subs", "#/settings"].includes(h)) onHash();
		});
		window.addEventListener("hashchange", onHash);
		document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") wipeHistoryOnExit(); });
		window.addEventListener("pagehide", wipeHistoryOnExit);
		return () => window.removeEventListener("hashchange", onHash);
	});
</script>

<div class="shell">
	<header class="topbar">
		<a class="brand" href="/" title="back to ramjet">
			<svg class="mark" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="var(--amber)" d="M11.6 39.6 L14.4 42.4 L4.7 50.7 L3.3 49.3 Z"/><path fill="var(--amber)" d="M20.6 48.6 L23.4 51.4 L15.7 57.7 L14.3 56.3 Z"/><path fill="var(--amber-deep)" d="M58 6 L12 22 L30 32 Z"/><path fill="var(--amber)" d="M58 6 L30 32 L40 50 Z"/></svg>
			<span class="word">jet<em>stream</em></span>
		</a>
		<form class="searchbox" autocomplete="off" spellcheck="false" on:submit|preventDefault={submit}>
			<svg class="sic" viewBox="0 0 24 24"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/></svg>
			<input type="search" inputmode="search" placeholder="search" aria-label="Search"
				bind:value={q} on:input={onInput} on:keydown={onKey}
				on:blur={() => setTimeout(() => (sugOpen = false), 150)}
				on:focus={() => { if (sugs.length && q.trim() === lastQ && q.trim().length > 1) sugOpen = true; }}>
			{#if sugOpen}
				<div class="sugs">
					{#each sugs as t, i}
						<button type="button" class="sug" class:on={i === sugActive} on:pointerdown|preventDefault={() => pick(t)}>{t}</button>
					{/each}
				</div>
			{/if}
		</form>
	</header>

	<nav class="side">
		{#each NAV as n}
			<a class="snav" class:on={route.name === n.name} href={n.href}>{@html ICON[n.icon]}<span>{n.label}</span></a>
		{/each}
		{#if $store.subs.length}
			<div class="ssep"></div>
			<div class="slabel">subscriptions</div>
			{#each $store.subs.slice(0, 8) as s}
				<a class="ssub" href={s.chId ? "#/c/" + encodeURIComponent(s.chId) : "#/s/" + encodeURIComponent(s.name)}>
					<span class="dot">{s.name.slice(0, 1).toUpperCase()}</span><span>{s.name}</span>
				</a>
			{/each}
		{/if}
	</nav>

	<main class="content">
		{#key route.name + (route.id || route.q || "")}
			{#if route.name === "watch"}<Watch id={route.id} />
			{:else if route.name === "channel"}<Channel id={route.id} />
			{:else if route.name === "playlist"}<Playlist id={route.id} />
			{:else if route.name === "search"}<Search q={route.q} />
			{:else if route.name === "trending"}<Trending />
			{:else if route.name === "history"}<History />
			{:else if route.name === "subs"}<Subs />
			{:else if route.name === "settings"}<Settings />
			{:else}<ForYou />{/if}
		{/key}
	</main>

	<nav class="tabbar">
		{#each NAV as n}
			<a class:on={route.name === n.name} href={n.href}>{@html ICON[n.icon]}<span>{n.label}</span></a>
		{/each}
	</nav>
</div>
