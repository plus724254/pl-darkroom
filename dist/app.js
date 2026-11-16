"use strict";

const elements = Object.fromEntries([
  "chooser", "editor", "chooser-status", "back-to-chooser", "return-editor", "tool-dock",
  "sample-button", "open-preview", "preview-dialog", "close-preview", "fullscreen-photo",
  "stage", "stage-message", "comparison", "photo", "original", "graded",
  "split", "file-label", "dimensions", "file-input", "dropzone", "filter-series", "preset", "preset-note", "strength",
  "strength-label", "strength-value", "grain-toggle", "grain-status", "grain-controls",
  "grain-strength", "grain-size", "grain-reset", "brightness", "brightness-value", "temperature", "temperature-value",
  "saturation", "saturation-value", "reset-adjustments", "preview-mode", "hold-original", "compare-hint",
  "held-preview", "held-original", "open-crop", "export-size", "export-dimensions", "format-box",
  "format", "download", "download-label", "notice",
].map(id => [id, document.getElementById(id)]));

const toolButtons = [...elements["tool-dock"].querySelectorAll(".tool-button[aria-expanded]")];
const themeColor = document.querySelector('meta[name="theme-color"]');
const originalContext = elements.original.getContext("2d", { willReadFrequently: true });
const gradedContext = elements.graded.getContext("2d");
const MAX_EXPORT_PIXELS = 50_000_000;
const MAX_EXPORT_EDGE = 8192;
const SOCIAL_EXPORT_EDGE = 2048;
const PREVIEW_EDGE = 1100;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const PHOTO_PRESS_DISTANCE = 8;
const ORIGINAL_HOLD_DELAY = 250;
const OUTPUT_FORMATS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

let photo;
let previewPixels;
let previewGrain;
let loadSequence = 0;
let loading = false;
let exportingPhoto;
let renderFrame;
let heifModule;
let heldSource;
let photoPress;
let previewClosePressed = false;

const colorControls = ["strength", "brightness", "temperature", "saturation"];
const cropEditor = createCropEditor((selection, geometry) => {
  if (selection !== photo) return;
  photo.geometry = geometry;
  setNotice();
  preparePreview();
});

function imageFromUrl(url) {
  const image = new Image();
  image.src = url;
  return image.decode().then(() => image);
}

function isHeif(file) {
  return /\.hei[cf]$/i.test(file.name) || /^image\/hei[cf]/i.test(file.type);
}

function loadHeifModule() {
  if (!heifModule) {
    heifModule = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "./vendor/libheif/libheif-bundle.js";
      script.onload = () => Promise.resolve().then(() => window.libheif()).then(resolve, reject);
      script.onerror = () => { script.remove(); reject(new Error("無法載入 HEIC 解碼器。")); };
      document.head.append(script);
    }).catch(error => {
      heifModule = undefined;
      throw error;
    });
  }
  return heifModule;
}

async function decodeHeif(file) {
  const lib = await loadHeifModule();
  const input = new Uint8Array(await file.arrayBuffer());
  const decoder = new lib.HeifDecoder();
  let images = [];
  try {
    images = decoder.decode(input);
    const image = images[0];
    if (!image) throw new Error("HEIC 解碼失敗。");
    const width = image.get_width();
    const height = image.get_height();
    if (!width || !height || width * height > 85_000_000) {
      throw new Error("這張 HEIC 照片的解析度過大。");
    }
    const pixels = new ImageData(width, height);
    const result = await new Promise((resolve, reject) => {
      image.display(pixels, data => {
        if (data) resolve(data);
        else reject(new Error("HEIC 解碼失敗。"));
      });
    });
    return await createImageBitmap(result);
  } finally {
    for (const image of images) image.free();
    if (decoder.decoder) lib.heif_context_free(decoder.decoder);
  }
}

async function decodeFile(file) {
  // A bitmap freezes animated inputs to their first frame and honors image orientation.
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    if (isHeif(file)) {
      const url = URL.createObjectURL(file);
      try {
        return await imageFromUrl(url);
      } catch {
        return await decodeHeif(file);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    throw new Error("無法讀取這張照片。請確認檔案完整，或改選 JPG、PNG 或 WebP。");
  }
}

function setNotice(message = "", isError = false) {
  elements.notice.classList.toggle("error", isError);
  elements.notice.textContent = message;
}

function updateDownloadButton() {
  elements.download.disabled = !photo || loading || Boolean(exportingPhoto);
  elements["download-label"].textContent = exportingPhoto ? "處理中…" : "下載照片";
  elements["open-crop"].disabled = !photo || loading;
  elements["open-preview"].disabled = !photo || loading;
  elements["return-editor"].disabled = loading;
}

function showEditor(visible) {
  elements.chooser.hidden = visible;
  elements.editor.hidden = !visible;
  elements["return-editor"].hidden = !photo;
  if (visible) setPhotoLoadMessage();
  themeColor.content = visible ? "#20221a" : "#f6f5ee";
  window.scrollTo(0, 0);
  const target = visible ? elements["open-preview"] : elements["file-input"];
  target.focus({ preventScroll: true });
}

function setActiveTool(active) {
  if (active?.id !== "filter-tool") setGrainControlsOpen(false);
  for (const button of toolButtons) {
    const expanded = button === active;
    button.setAttribute("aria-expanded", String(expanded));
    document.getElementById(button.getAttribute("aria-controls")).hidden = !expanded;
  }
}

function setPhotoLoadMessage(message = "", isError = false) {
  const status = elements["chooser-status"];
  status.textContent = message;
  status.classList.toggle("error", isError);
  elements["stage-message"].textContent = message;
  elements["stage-message"].hidden = !message;
}

function resetComparison(value) {
  elements.split.value = value;
  elements.photo.style.setProperty("--split", `${value}%`);
}

function selectedPreset() {
  return elements.preset.querySelector("input:checked");
}

function selectedGrain(presetId = selectedPreset().value) {
  return photo?.grainOverrides.get(presetId) ?? filmGrainProfiles[presetId] ?? defaultFilmGrain;
}

function colorSettings() {
  const preset = photoPresets[selectedPreset().value];
  return {
    preset,
    strength: preset ? Number(elements.strength.value) / 100 : 0,
    brightness: Number(elements.brightness.value),
    temperature: Number(elements.temperature.value),
    saturation: Number(elements.saturation.value),
  };
}

function editPixels(pixels, settings) {
  const { preset, strength, brightness, temperature, saturation } = settings;
  if (preset && strength) preset.grade(pixels, strength);
  if (!brightness && !temperature && !saturation) return;

  const exposure = 2 ** (brightness / 75);
  const warmth = temperature / 100;
  const redGain = exposure * (1 + 0.23 * warmth);
  const blueGain = exposure * (1 - 0.29 * warmth);
  const chroma = 1 + saturation / 100;
  for (let i = 0; i < pixels.length; i += 4) {
    const red = pixels[i] * redGain;
    const green = pixels[i + 1] * exposure;
    const blue = pixels[i + 2] * blueGain;
    const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    pixels[i] = luma + (red - luma) * chroma;
    pixels[i + 1] = luma + (green - luma) * chroma;
    pixels[i + 2] = luma + (blue - luma) * chroma;
  }
}

function renderPreview() {
  if (!previewPixels) return;
  const { width, height, data } = previewPixels;
  const pixels = new ImageData(new Uint8ClampedArray(data), width, height);
  editPixels(pixels.data, colorSettings());
  const { strength, size } = selectedGrain();
  if (strength !== "off") {
    if (previewGrain?.size !== size) {
      const field = createFilmGrainField(width, height, photo.geometry.crop, photo.grainSeed, size);
      previewGrain = { size, field: field(0, height) };
    }
    applyFilmGrain(pixels.data, previewGrain.field, strength);
  }
  gradedContext.putImageData(pixels, 0, 0);
}

function scaledSize({ width, height }, maxEdge, maxPixels = Infinity) {
  const scale = Math.min(1, maxEdge / Math.max(width, height), Math.sqrt(maxPixels / (width * height)));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function exportOptions(geometry = photo.geometry) {
  const social = elements["export-size"].value === "social";
  const format = social ? "image/jpeg" : elements.format.value;
  const size = scaledSize(geometry.crop, social ? SOCIAL_EXPORT_EDGE : MAX_EXPORT_EDGE, MAX_EXPORT_PIXELS);
  return { ...size, format, quality: social ? 0.82 : 0.94 };
}

function updateExportOptions() {
  const social = elements["export-size"].value === "social";
  elements["format-box"].hidden = social;
  if (!photo) return;
  const { width, height } = exportOptions();
  const crop = photo.geometry.crop;
  const limited = !social && (width < Math.round(crop.width) || height < Math.round(crop.height));
  elements["export-dimensions"].textContent = `${width} × ${height} px${limited ? " · 已套用尺寸上限" : ""}`;
}

function preparePreview() {
  cancelAnimationFrame(renderFrame);
  previewGrain = undefined;
  const { turn, crop } = photo.geometry;
  const { width: previewWidth, height: previewHeight } = scaledSize(crop, PREVIEW_EDGE);
  elements.original.width = elements.graded.width = previewWidth;
  elements.original.height = elements.graded.height = previewHeight;
  drawPhoto(originalContext, photo, turn, crop);
  previewPixels = originalContext.getImageData(0, 0, previewWidth, previewHeight);
  elements.photo.style.setProperty("--ratio", crop.width / crop.height);
  elements.dimensions.textContent = `${Math.max(1, Math.round(crop.width))} × ${Math.max(1, Math.round(crop.height))} px`;
  renderPreview();
  updateExportOptions();
}

function initializePhoto(source, name, isSample, inputType) {
  const width = source.naturalWidth || source.width;
  const height = source.naturalHeight || source.height;
  if (!width || !height) throw new Error("照片的尺寸無效。");
  const previous = photo;
  const next = {
    source, name, width, height,
    grainSeed: filmGrainSeed(name, width, height),
    grainOverrides: new Map(),
  };
  next.geometry = { turn: 0, crop: fullCrop(next, 0), ratio: "free" };
  photo = next;
  elements.format.value = /\.png$/i.test(name) || inputType === "image/png" ? "image/png" : "image/jpeg";
  elements.preset.querySelector("[value='none']").checked = true;
  updatePreset();
  resetAdjustments();
  preparePreview();
  if (previous && previous !== exportingPhoto) previous.source.close?.();
  heldSource = undefined;
  elements["held-original"].width = elements["held-original"].height = 1;
  elements["file-label"].textContent = isSample ? "示範照片 · 台北街景" : name;
  elements["file-label"].title = name;
  elements.comparison.hidden = false;
  elements["preview-mode"].querySelector('[value="direct"]').checked = true;
  updatePreviewMode();
  resetComparison(50);
}

async function loadPhoto(file) {
  const sequence = ++loadSequence;
  const isSample = !file;
  loading = true;
  cropEditor.close();
  clearPhotoPress();
  elements["preview-dialog"].close();
  setNotice();
  elements.stage.setAttribute("aria-busy", "true");
  setPhotoLoadMessage(isSample ? "載入示範照…" : "正在讀取照片…");
  updateDownloadButton();

  let loaded = false;
  try {
    if (file?.size > MAX_FILE_BYTES) throw new Error("單張照片請小於 100 MB。");
    const source = isSample ? await imageFromUrl(demoPhotoUrl) : await decodeFile(file);
    if (sequence !== loadSequence) {
      source.close?.();
      return;
    }
    initializePhoto(source, file?.name || "taipei-sample.jpg", isSample, file?.type);
    loaded = true;
  } catch (error) {
    if (sequence !== loadSequence) return;
    const message = isSample ? "示範照載入失敗，請選擇一張照片。"
      : error.message || "照片處理失敗，請重新選擇檔案。";
    setPhotoLoadMessage(message, true);
  } finally {
    if (sequence === loadSequence) {
      loading = false;
      elements.stage.setAttribute("aria-busy", "false");
      updateDownloadButton();
      if (loaded) {
        setActiveTool();
        showEditor(true);
      }
    }
  }
}

function encodeCanvas(canvas, format, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob || blob.type !== format) {
        reject(new Error("瀏覽器無法輸出此格式。請試用 JPG、PNG 或較小的照片。"));
      } else {
        resolve(blob);
      }
    }, format, quality);
  });
}

async function exportPhoto() {
  if (loading || exportingPhoto || !photo) return;
  const selection = photo;
  const sequence = loadSequence;
  const settings = colorSettings();
  const grain = selectedGrain();
  const { turn, crop } = selection.geometry;
  const { width, height, format, quality } = exportOptions();
  const canvas = document.createElement("canvas");
  exportingPhoto = selection;
  setNotice();
  updateDownloadButton();

  try {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    drawPhoto(context, selection, turn, crop);

    if (settings.strength || settings.brightness || settings.temperature || settings.saturation || grain.strength !== "off") {
      const field = grain.strength !== "off"
        ? createFilmGrainField(width, height, crop, selection.grainSeed, grain.size)
        : null;
      const pixelsPerBand = field ? 400_000 : 800_000;
      const rows = Math.max(1, Math.floor(pixelsPerBand / width));
      const grainBuffer = field && new Float32Array(width * Math.min(rows, height));
      for (let y = 0; y < height; y += rows) {
        const rowCount = Math.min(rows, height - y);
        const pixels = context.getImageData(0, y, width, rowCount);
        editPixels(pixels.data, settings);
        if (field) applyFilmGrain(pixels.data, field(y, rowCount, grainBuffer), grain.strength);
        context.putImageData(pixels, 0, y);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    if (format === "image/jpeg") {
      context.globalCompositeOperation = "destination-over";
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
    }

    const blob = await encodeCanvas(canvas, format, quality);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    const name = selection.name.replace(/\.[^.]+$/, "") || "photo";
    const suffix = settings.preset ? `-${settings.preset.suffix}` : "";
    link.download = `${name}${suffix}.${OUTPUT_FORMATS[format]}`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    if (sequence === loadSequence) setNotice(`已產生 ${width} × ${height} px 的照片。`);
  } catch (error) {
    if (sequence === loadSequence) {
      setNotice(error instanceof DOMException ? "無法輸出這張照片，請試用較小的照片。"
        : error.message || "無法輸出照片。", true);
    }
  } finally {
    canvas.width = canvas.height = 1;
    exportingPhoto = undefined;
    if (selection !== photo) selection.source.close?.();
    updateDownloadButton();
  }
}

function queuePreview() {
  cancelAnimationFrame(renderFrame);
  renderFrame = requestAnimationFrame(renderPreview);
}

function updatePreset() {
  const option = selectedPreset();
  const tile = option.closest("label");
  const activeName = tile.hidden ? `目前套用 ${tile.querySelector(".preset-tile").textContent} · ` : "";
  elements["preset-note"].textContent = activeName + option.dataset.note;
  elements.strength.disabled = !photoPresets[option.value];
  updateGrainControls();
  queuePreview();
}

function setGrainControlsOpen(open) {
  elements["grain-toggle"].setAttribute("aria-expanded", String(open));
  elements["grain-controls"].hidden = !open;
  elements["grain-reset"].hidden = !open;
  elements["strength-label"].hidden = open;
  elements.strength.hidden = open;
}

function updateGrainControls() {
  const presetId = selectedPreset().value;
  const { strength, size } = selectedGrain(presetId);
  elements["grain-strength"].value = strength;
  elements["grain-size"].value = size;
  elements["grain-size"].disabled = strength === "off";
  elements["grain-reset"].disabled = !photo?.grainOverrides.has(presetId);
  elements["grain-status"].textContent = strength === "off"
    ? "關閉"
    : `${strength === "weak" ? "弱" : "強"}・${size === "fine" ? "細" : "粗"}`;
}

function saveGrainControls() {
  const presetId = selectedPreset().value;
  const strength = elements["grain-strength"].value;
  const size = elements["grain-size"].value;
  const defaults = filmGrainProfiles[presetId] ?? defaultFilmGrain;
  if (strength === defaults.strength && size === defaults.size) photo.grainOverrides.delete(presetId);
  else photo.grainOverrides.set(presetId, { strength, size });
  updateGrainControls();
  queuePreview();
}

function updateFilterSeries() {
  const series = elements["filter-series"].querySelector("input:checked").value;
  for (const tile of elements.preset.querySelectorAll("[data-series]")) {
    tile.hidden = tile.dataset.series !== series;
  }
  updatePreset();
}

function updateColorControls() {
  for (const id of colorControls) {
    const input = elements[id];
    const value = Number(input.value);
    elements[`${id}-value`].textContent = id === "strength" ? `${value}%` : value > 0 ? `+${value}` : value;
    input.style.setProperty("--range-fill", `${100 * (value - input.min) / (input.max - input.min)}%`);
  }
  queuePreview();
}

function resetAdjustments() {
  for (const id of colorControls.slice(1)) elements[id].value = 0;
  updateColorControls();
}

function openFullscreenPreview(source = elements.graded) {
  const dialog = elements["preview-dialog"];
  if (loading || !photo || dialog.open) return;
  const canvas = elements["fullscreen-photo"];
  canvas.width = source.width;
  canvas.height = source.height;
  canvas.getContext("2d").drawImage(source, 0, 0);
  previewClosePressed = false;
  dialog.showModal();
}

function showOriginal(visible) {
  if (visible && (loading || !photo || elements["hold-original"].hidden)) return;
  if (visible && heldSource !== photo.source) {
    const canvas = elements["held-original"];
    const size = scaledSize(photo, PREVIEW_EDGE);
    canvas.width = size.width;
    canvas.height = size.height;
    drawPhoto(canvas.getContext("2d"), photo, 0, fullCrop(photo, 0));
    elements["held-preview"].style.setProperty("--ratio", photo.width / photo.height);
    heldSource = photo.source;
  }
  elements["held-preview"].hidden = !visible;
  elements.comparison.classList.toggle("show-original", visible);
}

function updatePreviewMode() {
  clearPhotoPress();
  const option = elements["preview-mode"].querySelector("input:checked");
  const mode = option.value;
  elements.comparison.dataset.mode = mode;
  elements.split.hidden = mode !== "split";
  elements["hold-original"].hidden = mode !== "direct";
  elements["compare-hint"].textContent = option.dataset.hint;
}

const hold = elements["hold-original"];
hold.addEventListener("contextmenu", event => event.preventDefault());
hold.addEventListener("keydown", event => {
  if (event.key !== " " && event.key !== "Enter") return;
  event.preventDefault();
  showOriginal(true);
});
hold.addEventListener("keyup", event => {
  if (event.key === " " || event.key === "Enter") showOriginal(false);
});
hold.addEventListener("blur", () => showOriginal(false));

function dragComparison(event) {
  const rect = elements.photo.getBoundingClientRect();
  resetComparison(clamp(Math.round(100 * (event.clientX - rect.left) / rect.width), 0, 100));
}

function clearPhotoPress() {
  clearTimeout(photoPress?.holdTimer);
  photoPress = undefined;
  showOriginal(false);
}

function movedFromPhotoPress(event, press) {
  return Math.hypot(event.clientX - press.x, event.clientY - press.y) >= PHOTO_PRESS_DISTANCE;
}

elements.photo.addEventListener("pointerdown", event => {
  if (!event.isPrimary || event.button !== 0 || loading || !photo) return;
  elements["stage-message"].hidden = true;
  const mode = elements.comparison.dataset.mode;
  const layer = event.target.closest(".photo-layer");
  if (mode === "side" && !layer) return;
  clearPhotoPress();

  const press = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    mode,
    source: mode === "side" && layer.classList.contains("original-layer") ? elements.original : elements.graded,
    moved: false,
    held: false,
  };
  photoPress = press;
  event.target.setPointerCapture(event.pointerId);

  if (mode === "direct") {
    press.holdTimer = setTimeout(() => {
      press.held = true;
      showOriginal(true);
    }, ORIGINAL_HOLD_DELAY);
  }
});

elements.photo.addEventListener("pointermove", event => {
  const press = photoPress;
  if (event.pointerId !== press?.id || press.held) return;
  if (!press.moved && movedFromPhotoPress(event, press)) {
    press.moved = true;
    clearTimeout(press.holdTimer);
    if (press.mode === "split" && event.pointerType === "mouse") elements.split.focus({ preventScroll: true });
  }
  if (press.moved && press.mode === "split") dragComparison(event);
});

elements.photo.addEventListener("pointerup", event => {
  const press = photoPress;
  if (event.pointerId !== press?.id) return;
  clearPhotoPress();
  if (!press.held && !press.moved && !movedFromPhotoPress(event, press)) {
    openFullscreenPreview(press.source);
  }
});

for (const type of ["pointercancel", "lostpointercapture"]) {
  elements.photo.addEventListener(type, event => {
    if (event.pointerId === photoPress?.id) clearPhotoPress();
  });
}
window.addEventListener("blur", clearPhotoPress);

elements["open-preview"].addEventListener("click", () => openFullscreenPreview());
elements["close-preview"].addEventListener("pointerdown", () => { previewClosePressed = true; });
elements["close-preview"].addEventListener("click", event => {
  // A browser can send the opening tap's click to the newly visible dialog.
  if (event.detail === 0 || previewClosePressed) elements["preview-dialog"].close();
});
elements["sample-button"].addEventListener("click", () => loadPhoto());
elements["back-to-chooser"].addEventListener("click", () => showEditor(false));
elements["return-editor"].addEventListener("click", () => showEditor(true));
for (const button of toolButtons) {
  button.addEventListener("click", event => {
    if (!loading) elements["stage-message"].hidden = true;
    const opening = button.getAttribute("aria-expanded") === "false";
    setActiveTool(opening ? button : undefined);
    if (opening) {
      const panel = document.getElementById(button.getAttribute("aria-controls"));
      panel.scrollTop = 0;
      if (event.detail === 0) panel.focus({ preventScroll: true });
    }
  });
}
elements["tool-dock"].addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  if (!elements["grain-controls"].hidden) {
    setGrainControlsOpen(false);
    elements["grain-toggle"].focus();
    return;
  }
  const active = toolButtons.find(button => button.getAttribute("aria-expanded") === "true");
  if (!active) return;
  setActiveTool();
  active.focus({ preventScroll: true });
});
elements["file-input"].addEventListener("change", event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (file) loadPhoto(file);
});
elements["filter-series"].addEventListener("change", updateFilterSeries);
elements.preset.addEventListener("change", updatePreset);
elements["grain-toggle"].addEventListener("click", () => setGrainControlsOpen(elements["grain-controls"].hidden));
elements["grain-strength"].addEventListener("change", saveGrainControls);
elements["grain-size"].addEventListener("change", saveGrainControls);
elements["grain-reset"].addEventListener("click", () => {
  photo.grainOverrides.delete(selectedPreset().value);
  updateGrainControls();
  elements["grain-strength"].focus();
  queuePreview();
});
for (const id of colorControls) elements[id].addEventListener("input", updateColorControls);
elements["reset-adjustments"].addEventListener("click", resetAdjustments);
elements["preview-mode"].addEventListener("change", updatePreviewMode);
elements["open-crop"].addEventListener("click", () => {
  setActiveTool();
  cropEditor.open(photo);
});
elements["export-size"].addEventListener("change", updateExportOptions);
elements.split.addEventListener("input", () => resetComparison(elements.split.value));
elements.download.addEventListener("click", exportPhoto);

for (const target of [elements.dropzone, elements.stage]) {
  target.addEventListener("dragover", event => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    elements.dropzone.classList.add("is-dragging");
  });
  target.addEventListener("dragleave", event => {
    if (!target.contains(event.relatedTarget)) elements.dropzone.classList.remove("is-dragging");
  });
  target.addEventListener("drop", event => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    elements.dropzone.classList.remove("is-dragging");
    loadPhoto(event.dataTransfer.files[0]);
  });
}

updateFilterSeries();
updatePreviewMode();
updateColorControls();
