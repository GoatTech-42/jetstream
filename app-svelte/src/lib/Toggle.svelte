<script>
	export let on = false;
	import { createEventDispatcher } from "svelte";
	const dispatch = createEventDispatcher();
</script>
<button class="tgl" class:on role="switch" aria-checked={on} on:click={() => dispatch("change", !on)} aria-label="toggle"></button>
