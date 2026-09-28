// All preview pages use the same URLs for the approved cat artwork.
const ROOT = new URL('../ui-components-v1/assets/web/', import.meta.url);
export function catImageSources(catId, retry = 0) {
  if (!/^cat-0[1-4]$/.test(catId)) throw new Error('Unknown cat artwork');
  const url = width => new URL(`${catId}-${width}.webp`, ROOT).href + (retry ? `?retry=${retry}` : '');
  return {src: url(320), srcset: `${url(320)} 320w, ${url(640)} 640w`, sizes: '200px'};
}
