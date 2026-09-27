<script>
	import { onMount, onDestroy } from "svelte";
	import { ICON } from "./icons.js";
	import { fmtT } from "./util.js";
	import { store, queue, setProgress, queueNext } from "./store.js";

	export let d;          // watch payload (with _qualities, _hdAudio)
	export let resume = 0;

	let v, wrap, seekEl;
	let playing = false, muted = false, vol = 1;
	let t = 0, dur = 0, bufPct = 0, spin = false;
	let ccOn = false, hasCc = false, hasPip = false;
	let speed = 1;
	let hideui = false;
	let qopen = false;
	export let curQ = d._startIdx || 0;
	let appliedQ = -1;
	let flashes = [];
	let au = null;
	let lastSave = 0, firstMeta = true, pendingSeek = null;
	let hideT = null, auTimer = null, pollTimer = null, audioBridge = null;
	const RATES = [1, 1.25, 1.5, 2, 0.75];

	function qualities() { return d._qualities || []; }

	function ensureAudio() {
		if (au || !d._hdAudio) return au;
		au = new Audio(d._hdAudio);
		au.preload = "auto";
		au.id = "paudio";
		au.style.display = "none";
		document.body.appendChild(au);
		return au;
	}
	function syncAudio(hard) {
		if (!au) return;
		if (hard || Math.abs(au.currentTime - v.currentTime) > 0.35) au.currentTime = v.currentTime;
	}
	function dropAudio() { if (au) { au.pause(); au.remove(); au = null; } }

	// curQ is bindable: Watch renders a quality row under the player.
	// The reactive below applies any external change; the first run just syncs.
	$: if (curQ !== appliedQ) {
		const first = appliedQ === -1;
		appliedQ = curQ;
		if (!first && v) applyQuality(curQ);
	}
	function applyQuality(i) {
		const q = qualities()[i];
		if (!q) return;
		const tt = v.currentTime, wasPlaying = !v.paused;
		if (q.hd && d._hdAudio) {
			ensureAudio();
			v.muted = true;
			v.src = q.src;
			if (au) au.muted = false;
		} else {
			dropAudio();
			v.muted = false;
			v.src = q.src;
		}
		pendingSeek = tt;
		if (wasPlaying) {
			if (au) au.play().catch(() => {});
			v.play().catch(() => {});
		}
	}

	function toggle() {
		if (v.paused) {
			if (d._hdAudio && qualities()[curQ] && qualities()[curQ].hd) {
				ensureAudio();
				if (au) { syncAudio(true); au.play().catch(() => {}); }
			}
			v.play().catch(() => {});
		} else {
			v.pause();
			if (au) au.pause();
		}
	}
	function showUI() {
		hideui = false;
		clearTimeout(hideT);
		if (!v.paused && !v.ended) hideT = setTimeout(() => (hideui = true), 2500);
	}
	function flash(txt) {
		const id = Math.random();
		flashes = [...flashes, { id, txt }];
		setTimeout(() => (flashes = flashes.filter((f) => f.id !== id)), 650);
	}
	function goFs() {
		if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
		if (wrap.requestFullscreen) wrap.requestFullscreen().catch(() => {});
		else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
	}
	function onTime() {
		playing = !v.paused && !v.ended;
		if (Date.now() - lastSave > 5000) { lastSave = Date.now(); setProgress(d.id, v.currentTime); }
		t = v.currentTime; dur = v.duration || 0;
		try { if (v.buffered.length && dur) bufPct = (v.buffered.end(v.buffered.length - 1) / dur) * 100; } catch (e) {}
	}
	function onMeta() {
		if (pendingSeek != null) { v.currentTime = pendingSeek; pendingSeek = null; }
		else if (firstMeta && resume > 10 && resume < v.duration - 10) v.currentTime = resume;
		firstMeta = false;
		dur = v.duration || 0;
	}
	function onEnded() {
		playing = false;
		setProgress(d.id, 0);
		if (!$store.settings.autoplayNext) return;
		const qn = queueNext($queue, d.id);
		if (qn) { location.hash = "#/w/" + qn.id; return; }
		const nxt = (d.related || [])[0];
		if (nxt) location.hash = "#/w/" + nxt.id;
	}
	function onPause() { setProgress(d.id, v.currentTime); if (au) au.pause(); playing = false; showUI(); }
	function pagehide() { setProgress(d.id, v.currentTime); }

	// seek bar: tap or drag
	let scrubbing = false;
	function seekTo(clientX) {
		const r = seekEl.getBoundingClientRect();
		const pct = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
		if (v.duration) v.currentTime = pct * v.duration;
		t = v.currentTime;
	}
	function seekDown(e) {
		scrubbing = true;
		try { seekEl.setPointerCapture(e.pointerId); } catch (err) {}
		seekTo(e.clientX); e.preventDefault(); showUI();
	}
	function seekMove(e) { if (scrubbing) { seekTo(e.clientX); showUI(); } }
	function seekUp() { scrubbing = false; }

	// tap: single toggles (short delay), double-tap edges seek +/-10s
	let tapT = 0, tapX = 0;
	function onTap(e) {
		const now = Date.now();
		const r = v.getBoundingClientRect();
		const x = r.width ? (e.clientX - r.left) / r.width : 0.5;
		if (now - tapT < 300 && Math.abs(x - tapX) < 0.3) {
			tapT = 0;
			if (x < 0.4) { v.currentTime = Math.max(0, v.currentTime - 10); flash("-10s"); }
			else if (x > 0.6) { v.currentTime = Math.min(v.duration || 0, v.currentTime + 10); flash("+10s"); }
			else toggle();
		} else {
			tapT = now; tapX = x;
			setTimeout(() => { if (tapT && Date.now() - tapT >= 280) { tapT = 0; toggle(); } }, 300);
		}
		t = v.currentTime; showUI();
	}

	function cycleSpeed() {
		const i = RATES.indexOf(v.playbackRate);
		v.playbackRate = RATES[(i + 1) % RATES.length];
		speed = v.playbackRate;
		showUI();
	}
	function togglePip() {
		if (document.pictureInPictureElement) { document.exitPictureInPicture().catch(() => {}); }
		else if (v.requestPictureInPicture) { v.requestPictureInPicture().catch(() => {}); }
		else if (v.webkitSupportsPresentationMode) { v.webkitSetPresentationMode(v.webkitPresentationMode === "picture-in-picture" ? "inline" : "picture-in-picture"); }
		showUI();
	}
	function toggleCc() {
		if (!v.textTracks || !v.textTracks.length) return;
		const tt = v.textTracks[0];
		tt.mode = tt.mode === "showing" ? "hidden" : "showing";
		ccOn = tt.mode === "showing";
		showUI();
	}
	function keydown(e) {
		if (!v || !v.isConnected) return;
		const tgt = e.target;
		if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.tagName === "SELECT" || tgt.isContentEditable)) return;
		const k = e.key.toLowerCase();
		if (k === " " || k === "k") { e.preventDefault(); toggle(); }
		else if (k === "j") { v.currentTime = Math.max(0, v.currentTime - 10); flash("-10s"); }
		else if (k === "l") { v.currentTime = Math.min(v.duration || 0, v.currentTime + 10); flash("+10s"); }
		else if (k === "arrowleft") { v.currentTime = Math.max(0, v.currentTime - 5); }
		else if (k === "arrowright") { v.currentTime = Math.min(v.duration || 0, v.currentTime + 5); }
		else if (k === "m") { v.muted = !v.muted; }
		else if (k === "f") { goFs(); }
		else return;
		t = v.currentTime; showUI();
	}

	onMount(() => {
		// initial HD pair: video-only stream starts muted, pair element carries sound
		if (qualities().some((x) => x.hd) && qualities()[curQ] && qualities()[curQ].hd && d._hdAudio) {
			v.muted = true;
			ensureAudio();
			if (au) { au.muted = false; au.volume = 1; }
		}
		muted = v.muted; vol = v.volume;
		v.play().catch(() => {});
		hasCc = !!(v.textTracks && v.textTracks.length);
		if (hasCc) ccOn = v.textTracks[0].mode === "showing";
		hasPip = !!(document.pictureInPictureEnabled || v.webkitSupportsPresentationMode);
		pollTimer = setInterval(() => {
			if (!v) return;
			playing = !v.paused && !v.ended;
			muted = v.muted; vol = v.volume; t = v.currentTime;
		}, 250);
		auTimer = setInterval(() => {
			if (!v || !v.isConnected) { clearInterval(auTimer); return; }
			if (!au) return;
			if (v.paused) { if (!au.paused) au.pause(); return; }
			if (au.paused) { syncAudio(true); au.play().catch(() => {}); return; }
			if (Math.abs(au.currentTime - v.currentTime) > 0.3) au.currentTime = v.currentTime;
		}, 600);
		window.addEventListener("pagehide", pagehide);
		document.addEventListener("keydown", keydown);
		// iOS/WKWebView: audio elements can't start without a gesture - the first
		// tap anywhere bridges sound for an already-playing HD pair.
		audioBridge = () => { if (v && !v.paused && au && au.paused) { syncAudio(true); au.play().catch(() => {}); } };
		document.addEventListener("touchstart", audioBridge, { passive: true });
		document.addEventListener("click", audioBridge);
	});
	onDestroy(() => {
		clearInterval(auTimer); clearInterval(pollTimer);
		clearTimeout(hideT);
		dropAudio();
		window.removeEventListener("pagehide", pagehide);
		document.removeEventListener("keydown", keydown);
		if (audioBridge) { document.removeEventListener("touchstart", audioBridge); document.removeEventListener("click", audioBridge); }
	});

	$: pct = dur ? (t / dur) * 100 : 0;
</script>

<div class="pwrap" class:hideui bind:this={wrap} on:mousemove={showUI} on:touchstart|passive={showUI}>
	<video bind:this={v} class="player" class:tall={d.vertical} playsinline preload="metadata" crossorigin="anonymous"
		src={qualities()[curQ] ? qualities()[curQ].src : ""} poster={d.thumb || undefined}
		on:loadedmetadata={onMeta} on:timeupdate={onTime} on:pause={onPause}
		on:play={() => { playing = true; if (au) { syncAudio(true); au.play().catch(() => {}); } showUI(); }}
		on:playing={() => { spin = false; playing = true; }}
		on:canplay={() => (spin = false)} on:waiting={() => (spin = true)}
		on:progress={onTime} on:durationchange={() => (dur = v.duration || 0)}
		on:volumechange={() => { muted = v.muted; vol = v.volume; if (au) { au.volume = v.muted ? 0 : v.volume; au.muted = v.muted; } }}
		on:ratechange={() => { speed = v.playbackRate; if (au) au.playbackRate = v.playbackRate; }}
		on:seeked={() => syncAudio(true)} on:ended={onEnded}
		on:click={onTap}>
		{#each d.captions || [] as c, i}
			<track kind="captions" srclang={c.lang} label={c.label} src={c.src} default={i === 0}>
		{/each}
	</video>
	{#if spin}<div class="pspinner"></div>{/if}
	{#each flashes as f (f.id)}<span class="pflash">{f.txt}</span>{/each}
	{#if !playing}<button class="pplay" aria-label="Play" on:click={toggle}>{@html ICON.play}</button>{/if}
	<div class="pctrl">
		<div class="pseek" bind:this={seekEl} on:pointerdown={seekDown} on:pointermove={seekMove} on:pointerup={seekUp}>
			<div class="pseek-buf" style="width:{bufPct}%"></div>
			<div class="pseek-fill" style="width:{pct}%"></div>
		</div>
		<div class="prow">
			<button class="pbtn" aria-label="Play/pause" on:click={() => { toggle(); showUI(); }}>{#if playing}{@html ICON.pause}{:else}{@html ICON.play}{/if}</button>
			<span class="ptime">{fmtT(t)} / {fmtT(dur)}</span>
			<span class="pgap"></span>
			<button class="pbtn" aria-label="Mute" on:click={() => { v.muted = !v.muted; showUI(); }}>{@html muted || vol === 0 ? ICON.mute : ICON.vol}</button>
			{#if hasCc}<button class="pbtn" class:on={ccOn} aria-label="Captions" on:click={toggleCc}>{@html ICON.cc}</button>{/if}
			<button class="pbtn pbtn-text" aria-label="Speed" on:click={cycleSpeed}>{("" + speed).replace(/\.0$/, "")}x</button>
			{#if qualities().length > 1}
				<button class="pbtn" class:on={qopen} aria-label="Quality" on:click={() => { qopen = !qopen; showUI(); }}>{@html ICON.gear}</button>
			{/if}
			{#if hasPip}<button class="pbtn" aria-label="Picture in picture" on:click={togglePip}>{@html ICON.pip}</button>{/if}
			<button class="pbtn" aria-label="Fullscreen" on:click={() => { goFs(); showUI(); }}>{@html ICON.fs}</button>
		</div>
	</div>
	{#if qopen}
		<div class="qmenu">
			{#each qualities() as q, i}
				<button class:on={i === curQ} on:click={() => { curQ = i; qopen = false; showUI(); }}><span>{q.q}</span>{#if q.hd}<span class="hd">hd</span>{/if}</button>
			{/each}
		</div>
	{/if}
</div>
