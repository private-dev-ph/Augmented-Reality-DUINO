export function createViewport(canvas, state) {
  const context = canvas.getContext('2d');
  const viewport = {
    resize() {
      const rect = canvas.getBoundingClientRect();
      state.viewport.dpr = Math.max(1, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(rect.width * state.viewport.dpr));
      canvas.height = Math.max(1, Math.round(rect.height * state.viewport.dpr));
      context.setTransform(state.viewport.dpr, 0, 0, state.viewport.dpr, 0, 0);
    },

    screenSize() {
      const rect = canvas.getBoundingClientRect();
      return { w: rect.width, h: rect.height };
    },

    screen(point) {
      const { w, h } = viewport.screenSize();
      return {
        x: w / 2 + state.viewport.offsetX + (point.x - state.viewport.center.x) * state.viewport.scale,
        y: h / 2 + state.viewport.offsetY - (point.y - state.viewport.center.y) * state.viewport.scale,
      };
    },

    world(x, y) {
      const { w, h } = viewport.screenSize();
      return {
        x: (x - w / 2 - state.viewport.offsetX) / state.viewport.scale + state.viewport.center.x,
        y: -((y - h / 2 - state.viewport.offsetY) / state.viewport.scale) + state.viewport.center.y,
      };
    },

    fit() {
      if (!state.data) return;
      const bounds = state.data.bounds;
      const { w, h } = viewport.screenSize();
      const width = Math.max(0.001, bounds.maxX - bounds.minX);
      const height = Math.max(0.001, bounds.maxY - bounds.minY);
      state.viewport.center = {
        x: (bounds.minX + bounds.maxX) / 2,
        y: (bounds.minY + bounds.maxY) / 2,
      };
      state.viewport.scale = Math.min(w / width, h / height) * 0.88;
      state.viewport.offsetX = 0;
      state.viewport.offsetY = 0;
    },

    zoom(factor, x, y) {
      if (!state.data) return;
      const { w, h } = viewport.screenSize();
      const targetX = x ?? w / 2;
      const targetY = y ?? h / 2;
      const before = viewport.world(targetX, targetY);
      state.viewport.scale = Math.max(0.05, Math.min(500, state.viewport.scale * factor));
      const after = viewport.screen(before);
      state.viewport.offsetX += targetX - after.x;
      state.viewport.offsetY += targetY - after.y;
    },

    pan(deltaX, deltaY) {
      state.viewport.offsetX += deltaX;
      state.viewport.offsetY += deltaY;
    },

    setDragging(value, x = 0, y = 0) {
      state.viewport.dragging = value;
      state.viewport.lastX = x;
      state.viewport.lastY = y;
    },
  };

  return viewport;
}
