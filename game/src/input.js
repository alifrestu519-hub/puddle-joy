// Keyboard and mouse, read as one bitmask of actions per frame.
// Movement is WASD or arrows; Space dashes; P or Escape pauses; R restarts;
// M mutes; 1/2/3 pick a level-up card; click fires a burst toward the mouse.
export const ACTION_CONFIRM = 1;
export const ACTION_PAUSE = 2;
export const ACTION_RESTART = 4;
export const ACTION_MUTE = 8;
export const ACTION_DASH = 16;
export const ACTION_PICK_1 = 32;
export const ACTION_PICK_2 = 64;
export const ACTION_PICK_3 = 128;

const KEY_ACTIONS = {
  Space: ACTION_CONFIRM,
  Enter: ACTION_CONFIRM,
  KeyP: ACTION_PAUSE,
  Escape: ACTION_PAUSE,
  KeyR: ACTION_RESTART,
  KeyM: ACTION_MUTE,
  Digit1: ACTION_PICK_1,
  Digit2: ACTION_PICK_2,
  Digit3: ACTION_PICK_3,
  Numpad1: ACTION_PICK_1,
  Numpad2: ACTION_PICK_2,
  Numpad3: ACTION_PICK_3,
};

export function createInput(canvas) {
  const keys = new Set();
  let actions = 0;
  let mouse = { x: 640, y: 360, down: false, clicked: false };
  let mouseDown = false;

  function toGame(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * 1280,
      y: ((clientY - rect.top) / rect.height) * 720,
    };
  }

  window.addEventListener('keydown', (event) => {
    if (event.code === 'Space') event.preventDefault();
    if (event.repeat) return;
    keys.add(event.code);
    const action = KEY_ACTIONS[event.code];
    if (action) actions |= action;
    if (event.code === 'Space') actions |= ACTION_DASH;
  });
  window.addEventListener('keyup', (event) => keys.delete(event.code));
  window.addEventListener('blur', () => keys.clear());
  canvas.addEventListener('pointermove', (event) => {
    const p = toGame(event.clientX, event.clientY);
    mouse.x = p.x;
    mouse.y = p.y;
  });
  canvas.addEventListener('pointerdown', (event) => {
    const p = toGame(event.clientX, event.clientY);
    mouse.x = p.x;
    mouse.y = p.y;
    mouseDown = true;
    mouse.clicked = true;
    actions |= ACTION_CONFIRM;
  });
  window.addEventListener('pointerup', () => {
    mouseDown = false;
  });

  return {
    /** -1, 0 or 1 on each axis, from the keys held down. */
    direction() {
      let x = 0;
      let y = 0;
      if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1;
      if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1;
      if (keys.has('KeyW') || keys.has('ArrowUp')) y -= 1;
      if (keys.has('KeyS') || keys.has('ArrowDown')) y += 1;
      return { x, y };
    },
    mouse() {
      return mouse;
    },
    mouseDown() {
      return mouseDown;
    },
    /** Actions pressed since the last call; each press is reported once. */
    takeActions() {
      const taken = actions;
      actions = 0;
      return taken;
    },
    /** True only on the frame the mouse was clicked. */
    takeClick() {
      const clicked = mouse.clicked;
      mouse.clicked = false;
      return clicked;
    },
  };
}
