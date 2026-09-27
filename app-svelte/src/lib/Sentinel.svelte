<script>
	import { onMount, createEventDispatcher } from "svelte";
	const dispatch = createEventDispatcher();
	export let rootMargin = "900px";
	let el, obs;
	onMount(() => {
		obs = new IntersectionObserver((ents) => {
			if (ents.some((x) => x.isIntersecting)) dispatch("reach");
		}, { rootMargin });
		obs.observe(el);
		return () => obs && obs.disconnect();
	});
	export function disconnect() { if (obs) obs.disconnect(); }
</script>
<div bind:this={el} style="height:1px"></div>
