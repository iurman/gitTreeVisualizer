/* -------------------------------------------------------------------------- */
/* The render target                                                           */
/*                                                                            */
/* Width is fixed so a pixel is the same size on a laptop and on a monitor;    */
/* only the height follows the aspect ratio. Both backends draw into a target  */
/* of exactly this size and then blit it up with nearest-neighbour filtering,  */
/* which is what makes the two renderers produce the same picture rather than  */
/* two resolutions of it.                                                      */
/* -------------------------------------------------------------------------- */

export const BASE_WIDTH = 480;
export const BASE_HEIGHT = 270;

export function targetSize(aspect: number, scale = 1): [number, number] {
  const w = Math.max(64, Math.round(BASE_WIDTH * scale));
  const h = Math.max(48, Math.round(w / Math.max(0.2, aspect) / 2) * 2);
  return [w, h];
}
