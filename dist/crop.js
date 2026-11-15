"use strict";

function orientedSize(photo, turn) {
  return turn % 2 ? { width: photo.height, height: photo.width }
    : { width: photo.width, height: photo.height };
}

function fullCrop(photo, turn) {
  return { x: 0, y: 0, ...orientedSize(photo, turn) };
}

function drawPhoto(context, photo, turn, crop) {
  const { width, height } = context.canvas;
  context.save();
  context.clearRect(0, 0, width, height);
  context.scale(width / crop.width, height / crop.height);
  context.translate(-crop.x, -crop.y);
  const offsets = [[0, 0], [photo.height, 0], [photo.width, photo.height], [0, photo.width]];
  context.translate(...offsets[turn]);
  context.rotate(turn * Math.PI / 2);
  context.drawImage(photo.source, 0, 0, photo.width, photo.height);
  context.restore();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

function cropAspect(ratio) {
  const [width, height] = ratio.split(":").map(Number);
  return height ? width / height : null;
}

function fitCrop(bounds, aspect, center = bounds) {
  const width = Math.min(bounds.width, bounds.height * aspect);
  const height = width / aspect;
  return {
    x: clamp(center.x + (center.width - width) / 2, 0, bounds.width - width),
    y: clamp(center.y + (center.height - height) / 2, 0, bounds.height - height),
    width, height,
  };
}

function dragCrop(crop, bounds, corner, dx, dy, aspect, minWidth, minHeight) {
  if (!corner) {
    return { ...crop, x: clamp(crop.x + dx, 0, bounds.width - crop.width),
      y: clamp(crop.y + dy, 0, bounds.height - crop.height) };
  }

  const left = corner.endsWith("w");
  const top = corner.startsWith("n");
  const anchorX = left ? crop.x + crop.width : crop.x;
  const anchorY = top ? crop.y + crop.height : crop.y;
  const maxWidth = left ? anchorX : bounds.width - anchorX;
  const maxHeight = top ? anchorY : bounds.height - anchorY;
  let width = crop.width + (left ? -dx : dx);
  let height = crop.height + (top ? -dy : dy);

  if (aspect) {
    const max = Math.min(maxWidth, maxHeight * aspect);
    const min = Math.min(max, Math.max(minWidth, minHeight * aspect));
    // Project the pointer onto the fixed-ratio diagonal in image coordinates.
    width = clamp((width + height / aspect) / (1 + 1 / (aspect * aspect)), min, max);
    height = width / aspect;
  } else {
    width = clamp(width, Math.min(minWidth, maxWidth), maxWidth);
    height = clamp(height, Math.min(minHeight, maxHeight), maxHeight);
  }

  return { x: left ? anchorX - width : anchorX, y: top ? anchorY - height : anchorY, width, height };
}

function createCropEditor(onApply) {
  const dialog = document.getElementById("crop-dialog");
  const canvas = document.getElementById("crop-canvas");
  const frame = document.getElementById("crop-photo");
  const selection = document.getElementById("crop-selection");
  const ratio = document.getElementById("crop-ratio");
  const context = canvas.getContext("2d");
  let photo;
  let draft;
  let drag;

  function renderSelection() {
    const { width, height } = orientedSize(photo, draft.turn);
    const crop = draft.crop;
    selection.style.left = `${100 * crop.x / width}%`;
    selection.style.top = `${100 * crop.y / height}%`;
    selection.style.width = `${100 * crop.width / width}%`;
    selection.style.height = `${100 * crop.height / height}%`;
  }

  function renderCrop() {
    const bounds = fullCrop(photo, draft.turn);
    const scale = Math.min(1, 1100 / Math.max(bounds.width, bounds.height));
    canvas.width = Math.max(1, Math.round(bounds.width * scale));
    canvas.height = Math.max(1, Math.round(bounds.height * scale));
    frame.style.setProperty("--ratio", bounds.width / bounds.height);
    drawPhoto(context, photo, draft.turn, bounds);
    ratio.value = draft.ratio;
    renderSelection();
  }

  function rotate(direction) {
    const { width, height } = orientedSize(photo, draft.turn);
    const crop = draft.crop;
    draft.turn = (draft.turn + direction + 4) % 4;
    draft.crop = {
      x: direction > 0 ? Math.max(0, height - (crop.y + crop.height)) : crop.y,
      y: direction > 0 ? crop.x : Math.max(0, width - (crop.x + crop.width)),
      width: crop.height, height: crop.width,
    };
    if (draft.ratio !== "free") draft.ratio = draft.ratio.split(":").reverse().join(":");
    renderCrop();
  }

  ratio.addEventListener("change", () => {
    draft.ratio = ratio.value;
    const aspect = cropAspect(draft.ratio);
    if (aspect) draft.crop = fitCrop(fullCrop(photo, draft.turn), aspect, draft.crop);
    renderSelection();
  });

  function adjustCrop(start, corner, dx, dy, rect = frame.getBoundingClientRect()) {
    const bounds = fullCrop(photo, draft.turn);
    const scaleX = bounds.width / rect.width;
    const scaleY = bounds.height / rect.height;
    draft.crop = dragCrop(start, bounds, corner, dx * scaleX, dy * scaleY,
      cropAspect(draft.ratio), Math.max(1, 30 * scaleX), Math.max(1, 30 * scaleY));
    renderSelection();
  }

  selection.addEventListener("pointerdown", event => {
    if (!event.isPrimary || event.button !== 0) return;
    selection.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, crop: draft.crop,
      corner: event.target.dataset.corner, rect: frame.getBoundingClientRect() };
  });
  selection.addEventListener("pointermove", event => {
    if (drag?.id !== event.pointerId) return;
    adjustCrop(drag.crop, drag.corner, event.clientX - drag.x, event.clientY - drag.y, drag.rect);
  });
  selection.addEventListener("lostpointercapture", () => { drag = undefined; });
  selection.addEventListener("keydown", event => {
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!direction) return;
    event.preventDefault();
    const step = event.shiftKey ? 10 : 2;
    adjustCrop(draft.crop, event.target.dataset.corner, direction[0] * step, direction[1] * step);
  });

  document.getElementById("rotate-left").addEventListener("click", () => rotate(-1));
  document.getElementById("rotate-right").addEventListener("click", () => rotate(1));
  document.getElementById("reset-crop").addEventListener("click", () => {
    draft = { turn: 0, crop: fullCrop(photo, 0), ratio: "free" };
    renderCrop();
  });
  document.getElementById("cancel-crop").addEventListener("click", () => dialog.close());
  document.getElementById("apply-crop").addEventListener("click", () => {
    onApply(photo, draft);
    dialog.close();
  });
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    drag = photo = draft = undefined;
    canvas.width = canvas.height = 1;
  });

  return {
    open(currentPhoto) {
      photo = currentPhoto;
      draft = { ...photo.geometry };
      renderCrop();
      if (!dialog.open) dialog.showModal();
    },
    close() { if (dialog.open) dialog.close(); },
  };
}
