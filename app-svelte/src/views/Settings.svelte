<script>
	import { store, setSetting } from "../lib/store.js";
	import Toggle from "../lib/Toggle.svelte";
	const QUALS = ["auto", "1080p", "720p", "480p", "360p"];
</script>

<div class="viewfade">
<div class="settings">
	<div class="sec" style="margin-left:0"><h2>settings</h2></div>
	<div class="setgroup">
		<div class="setrow"><span>autoplay next video</span><Toggle on={$store.settings.autoplayNext} on:change={(e) => setSetting("autoplayNext", e.detail)} /></div>
		<div class="setrow"><span>resume where i left off</span><Toggle on={$store.settings.resume} on:change={(e) => setSetting("resume", e.detail)} /></div>
		<div class="setrow"><span>for-you ranking</span><Toggle on={$store.settings.algo} on:change={(e) => setSetting("algo", e.detail)} /></div>
		<div class="setrow"><span>clear watch history when i close jetstream</span><Toggle on={$store.settings.clearOnExit} on:change={(e) => setSetting("clearOnExit", e.detail)} /></div>
	</div>
	<div class="setgroup">
		<div class="setrow"><span>default quality</span>
			<select value={$store.settings.quality} on:change={(e) => setSetting("quality", e.target.value)}>
				{#each QUALS as q}<option value={q} selected={$store.settings.quality === q}>{q}</option>{/each}
			</select>
		</div>
	</div>
	<p class="dim" style="font-size:12.5px">synced to your ramjet account - same settings, history and subscriptions on every device.</p>
</div>
</div>
