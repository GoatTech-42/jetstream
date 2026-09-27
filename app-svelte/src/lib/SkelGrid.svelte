<script>
	export let n = 8;
</script>
<div class="grid">
	{#each Array(n) as _, i}
		<div class="skel"><div class="skel-thumb"></div><div class="skel-line"></div><div class="skel-line short"></div></div>
	{/each}
</div>
