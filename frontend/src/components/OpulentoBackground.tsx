/**
 * Pure-CSS animated gradient background inspired by uvcanvas/Opulento.
 * No WebGL, no external shader lib — four blurred radial blobs drifting
 * on a dark base. GPU-accelerated via transform/opacity only so it stays
 * at 60 fps on the thinnest clinic laptops.
 */
export function OpulentoBackground() {
  return (
    <div className="fixed inset-0 -z-10 overflow-hidden bg-[#05060a]">
      <div className="opu-blob opu-blob-1" />
      <div className="opu-blob opu-blob-2" />
      <div className="opu-blob opu-blob-3" />
      <div className="opu-blob opu-blob-4" />
      <div className="opu-grain" />
    </div>
  );
}
