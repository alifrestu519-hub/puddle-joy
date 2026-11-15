// Everything the player sees: the night arena, the lantern light, the
// creatures, the particles and every screen (title, play, level-up, pause,
// victory, game over). The canvas is scaled to the window; all drawing is
// done in the fixed 1280x720 logical field.
import { FIELD, FONT, PALETTE, WAVE_QUOTA, WAVES } from './config.js';

export const SCREEN_TITLE = 'title';
export const SCREEN_PLAY = 'play';
export const SCREEN_LEVEL = 'level';
export const SCREEN_PAUSED = 'paused';
export const SCREEN_VICTORY = 'victory';
export const SCREEN_OVER = 'over';

const TAU = Math.PI * 2;

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  const DPR = Math.min(2, window.devicePixelRatio || 1);

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.floor(w * DPR);
    canvas.height = Math.floor(h * DPR);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
  resize();
  window.addEventListener('resize', resize);

  function circle(x, y, r, colour) {
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
  }

  function drawBackground(state) {
    const g = ctx.createRadialGradient(640, 360, 60, 640, 360, 900);
    g.addColorStop(0, PALETTE.backdrop);
    g.addColorStop(1, PALETTE.backdropEdge);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, FIELD.width, FIELD.height);

    // Stars, twinkling with the world's own clock.
    for (const s of state.stars) {
      const a = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(state.time * s.speed + s.twinkle));
      ctx.globalAlpha = a;
      circle(s.x, s.y, s.r, '#cdd6ff');
    }
    ctx.globalAlpha = 1;

    // Ground: a soft arena floor with a dotted texture and a golden ring.
    ctx.fillStyle = PALETTE.ground;
    ctx.beginPath();
    ctx.arc(640, 360, 330, 0, TAU);
    ctx.fill();
    ctx.fillStyle = PALETTE.groundDot;
    for (let gx = 340; gx <= 940; gx += 44) {
      for (let gy = 90; gy <= 630; gy += 44) {
        const dx = gx - 640;
        const dy = gy - 360;
        if (dx * dx + dy * dy < 330 * 330) circle(gx, gy, 2, PALETTE.groundDot);
      }
    }
    ctx.strokeStyle = 'rgba(245, 185, 66, 0.25)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(640, 360, 330, 0, TAU);
    ctx.stroke();

    // The lantern's warm light around the player.
    const p = state.player;
    const light = ctx.createRadialGradient(p.x, p.y, 10, p.x, p.y, 300);
    light.addColorStop(0, 'rgba(255, 217, 122, 0.20)');
    light.addColorStop(0.55, 'rgba(255, 185, 66, 0.07)');
    light.addColorStop(1, 'rgba(255, 185, 66, 0)');
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, FIELD.width, FIELD.height);
  }

  function drawShard(s, time) {
    const bob = Math.sin(time * 4 + s.x * 0.05) * 2;
    const blink = 0.75 + 0.25 * Math.sin(time * 6 + s.y * 0.07);
    ctx.save();
    ctx.globalAlpha = blink;
    ctx.translate(s.x, s.y + bob);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = PALETTE.shard;
    ctx.fillRect(-5, -5, 10, 10);
    ctx.fillStyle = '#eafff5';
    ctx.fillRect(-2.5, -2.5, 5, 5);
    ctx.restore();
  }

  function drawEnemy(e, time) {
    const flash = e.hitFlash > 0;
    const wob = Math.sin(e.wobble) * 2;
    ctx.save();
    ctx.translate(e.x, e.y + wob * 0.4);
    if (flash) ctx.globalAlpha = 0.85;

    if (e.kind === 'cinder') {
      // A smouldering ember with angry eyes.
      circle(0, 0, e.radius, flash ? '#ffffff' : e.colour);
      circle(0, 0, e.radius * 0.62, '#7a1f1a');
      ctx.fillStyle = '#ffd97a';
      circle(-5, -4, 2.5, '#ffd97a');
      circle(5, -4, 2.5, '#ffd97a');
    } else if (e.kind === 'spark') {
      // A darting spark: a four-point star.
      ctx.fillStyle = flash ? '#ffffff' : e.colour;
      ctx.beginPath();
      ctx.moveTo(0, -e.radius);
      ctx.quadraticCurveTo(4, -4, e.radius, 0);
      ctx.quadraticCurveTo(4, 4, 0, e.radius);
      ctx.quadraticCurveTo(-4, 4, -e.radius, 0);
      ctx.quadraticCurveTo(-4, -4, 0, -e.radius);
      ctx.fill();
      ctx.fillStyle = '#fff3c4';
      circle(0, 0, 4, '#fff3c4');
    } else if (e.kind === 'gloom') {
      // A heavy gloom: a dark mound with a glowing crack.
      circle(0, 0, e.radius, flash ? '#ffffff' : e.colour);
      ctx.strokeStyle = '#e8dcff';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(-e.radius * 0.5, 0);
      ctx.lineTo(-e.radius * 0.15, 6);
      ctx.lineTo(e.radius * 0.2, -4);
      ctx.lineTo(e.radius * 0.55, 2);
      ctx.stroke();
      ctx.fillStyle = '#fff';
      circle(-7, -8, 3, '#fff');
      circle(7, -8, 3, '#fff');
    } else if (e.kind === 'mote') {
      // A drifting mote that splits when it dies.
      circle(0, 0, e.radius, flash ? '#ffffff' : e.colour);
      circle(0, 0, e.radius * 0.55, '#2c5c40');
      ctx.fillStyle = '#d8ffe9';
      circle(-4, -3, 2, '#d8ffe9');
      circle(4, -3, 2, '#d8ffe9');
    } else if (e.kind === 'spitter') {
      // A spitter: a blue orb with a wide mouth.
      circle(0, 0, e.radius, flash ? '#ffffff' : e.colour);
      ctx.fillStyle = '#0b2a3d';
      ctx.beginPath();
      ctx.arc(0, 3, e.radius * 0.45, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#fff';
      circle(-5, -6, 2.5, '#fff');
      circle(5, -6, 2.5, '#fff');
    } else if (e.kind === 'boss') {
      // The Ashen Maw: a huge burning skull-ember.
      const pulse = 1 + 0.04 * Math.sin(time * 3);
      ctx.scale(pulse, pulse);
      circle(0, 0, e.radius, flash ? '#ffffff' : '#3d0f16');
      ctx.strokeStyle = e.colour;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(0, 0, e.radius - 3, 0, TAU);
      ctx.stroke();
      // Horns.
      ctx.strokeStyle = '#ffb3bd';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(-e.radius * 0.7, -e.radius * 0.6);
      ctx.lineTo(-e.radius * 1.05, -e.radius * 1.15);
      ctx.moveTo(e.radius * 0.7, -e.radius * 0.6);
      ctx.lineTo(e.radius * 1.05, -e.radius * 1.15);
      ctx.stroke();
      // Burning eyes and a maw.
      ctx.fillStyle = '#ffd97a';
      circle(-16, -10, 6, '#ffd97a');
      circle(16, -10, 6, '#ffd97a');
      ctx.fillStyle = '#1a0508';
      ctx.beginPath();
      ctx.arc(0, 12, 16, 0, Math.PI);
      ctx.fill();
      ctx.fillStyle = '#ffcf5c';
      for (let i = -2; i <= 2; i += 1) {
        ctx.beginPath();
        ctx.moveTo(i * 7 - 3, 12);
        ctx.lineTo(i * 7, 22);
        ctx.lineTo(i * 7 + 3, 12);
        ctx.fill();
      }
    }
    ctx.restore();

    // A health bar over anything hurt.
    if (e.hp < e.maxHp && e.kind !== 'boss') {
      const w = e.radius * 2;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(e.x - w / 2, e.y - e.radius - 12, w, 4);
      ctx.fillStyle = PALETTE.hp;
      ctx.fillRect(e.x - w / 2, e.y - e.radius - 12, w * Math.max(0, e.hp / e.maxHp), 4);
    }
  }

  function drawPlayer(state) {
    const p = state.player;
    const blink = p.invulnerable > 0 && p.dashTime <= 0 && Math.floor(state.time * 14) % 2 === 0;
    ctx.save();
    ctx.translate(p.x, p.y);
    if (blink) ctx.globalAlpha = 0.45;

    // A soft glow under the keeper.
    const glow = ctx.createRadialGradient(0, 0, 4, 0, 0, 46);
    glow.addColorStop(0, 'rgba(255, 217, 122, 0.5)');
    glow.addColorStop(1, 'rgba(255, 217, 122, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, 46, 0, TAU);
    ctx.fill();

    // The keeper: a hooded wisp with a swinging lantern.
    const bob = p.moving ? Math.sin(p.walkPhase) * 2 : Math.sin(state.time * 2) * 1.5;
    ctx.translate(0, bob);
    ctx.fillStyle = '#2c3a6e';
    ctx.beginPath();
    ctx.moveTo(0, -p.radius - 4);
    ctx.quadraticCurveTo(p.radius, -p.radius * 0.4, p.radius * 0.8, p.radius * 0.7);
    ctx.quadraticCurveTo(0, p.radius + 6, -p.radius * 0.8, p.radius * 0.7);
    ctx.quadraticCurveTo(-p.radius, -p.radius * 0.4, 0, -p.radius - 4);
    ctx.fill();
    // Face.
    ctx.fillStyle = PALETTE.playerCore;
    circle(0, -4, 8, PALETTE.playerCore);
    ctx.fillStyle = '#1a2040';
    circle(-3, -5, 1.8, '#1a2040');
    circle(3, -5, 1.8, '#1a2040');
    // The lantern, held out toward the aim.
    const lx = Math.cos(p.aim) * 24;
    const ly = Math.sin(p.aim) * 24;
    ctx.strokeStyle = '#8a6a2f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(lx, ly);
    ctx.stroke();
    const flicker = 0.85 + 0.15 * Math.sin(state.time * 9 + p.x);
    ctx.fillStyle = `rgba(255, 217, 122, ${flicker})`;
    ctx.beginPath();
    ctx.arc(lx, ly, 8, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#fff3c4';
    circle(lx, ly, 4, '#fff3c4');
    ctx.restore();
  }

  function drawParticles(state) {
    for (const pt of state.particles) {
      if (!pt.active) continue;
      ctx.globalAlpha = Math.max(0, pt.life / pt.maxLife);
      circle(pt.x, pt.y, pt.size, pt.colour);
    }
    ctx.globalAlpha = 1;
  }

  function drawTexts(state) {
    ctx.textAlign = 'center';
    for (const t of state.texts) {
      if (!t.active) continue;
      ctx.globalAlpha = Math.min(1, t.life / 0.45);
      ctx.font = `700 ${t.size}px ${FONT}`;
      ctx.fillStyle = t.colour;
      ctx.fillText(t.text, t.x, t.y);
    }
    ctx.globalAlpha = 1;
  }

  function drawBar(x, y, w, h, frac, colour, back) {
    ctx.fillStyle = back;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = colour;
    ctx.fillRect(x, y, w * Math.max(0, Math.min(1, frac)), h);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  function drawHud(state, screen) {
    const p = state.player;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    // Top-left: health and lantern charge (dash).
    ctx.font = `700 13px ${FONT}`;
    ctx.fillStyle = PALETTE.muted;
    ctx.fillText('HEALTH', 24, 30);
    drawBar(24, 38, 220, 14, p.hp / p.maxHp, PALETTE.hp, PALETTE.hpBack);
    ctx.fillStyle = PALETTE.text;
    ctx.font = `700 13px ${FONT}`;
    ctx.fillText(`${Math.ceil(p.hp)} / ${p.maxHp}`, 252, 50);
    ctx.fillStyle = PALETTE.muted;
    ctx.fillText('DASH', 24, 72);
    const dashFrac = 1 - p.dashTimer / p.dashCooldown;
    drawBar(24, 80, 220, 8, dashFrac, '#8be9c9', PALETTE.hpBack);
    if (dashFrac >= 1) {
      ctx.fillStyle = '#8be9c9';
      ctx.fillText('READY — SPACE', 252, 88);
    }

    // Top-centre: wave and timer.
    ctx.textAlign = 'center';
    ctx.font = `800 22px ${FONT}`;
    ctx.fillStyle = PALETTE.text;
    const waveLabel = state.waveState === 'boss' || (state.wave === WAVES && state.bossSpawned)
      ? 'FINAL WAVE — THE ASHEN MAW'
      : state.waveState === 'rest'
        ? `WAVE ${state.wave} CLEARED`
        : `WAVE ${state.wave} / ${WAVES}`;
    ctx.fillText(waveLabel, 640, 34);
    const quota = WAVE_QUOTA[state.wave - 1];
    ctx.font = `600 14px ${FONT}`;
    ctx.fillStyle = PALETTE.muted;
    const mins = Math.floor(state.time / 60);
    const secs = Math.floor(state.time % 60);
    const clock = `${mins}:${String(secs).padStart(2, '0')}`;
    ctx.fillText(`Felled ${state.waveKills} / ${quota}   ·   ${clock}`, 640, 56);

    // Top-right: score, level, kills.
    ctx.textAlign = 'right';
    ctx.font = `800 22px ${FONT}`;
    ctx.fillStyle = PALETTE.text;
    ctx.fillText(`${state.score}`, 1256, 34);
    ctx.font = `600 14px ${FONT}`;
    ctx.fillStyle = PALETTE.muted;
    ctx.fillText(`LEVEL ${state.level}   ·   ${state.kills} felled`, 1256, 56);

    // Bottom: XP bar.
    drawBar(24, 692, 1232, 10, state.xp / state.xpNext, PALETTE.xp, PALETTE.hpBack);
    ctx.font = `700 12px ${FONT}`;
    ctx.fillStyle = PALETTE.muted;
    ctx.textAlign = 'left';
    ctx.fillText(`EMBER ${state.xp} / ${state.xpNext} — level ${state.level}`, 24, 686);

    // Boss bar.
    if (state.boss && state.boss.active) {
      ctx.textAlign = 'center';
      ctx.font = `800 15px ${FONT}`;
      ctx.fillStyle = '#ffb3bd';
      ctx.fillText('THE ASHEN MAW', 640, 92);
      drawBar(440, 100, 400, 12, state.boss.hp / state.boss.maxHp, '#ff5d73', '#2a1020');
    }

    // Wave-rest banner.
    if (state.waveState === 'rest' && screen === SCREEN_PLAY) {
      ctx.textAlign = 'center';
      ctx.font = `800 30px ${FONT}`;
      ctx.fillStyle = PALETTE.lantern;
      ctx.fillText(`WAVE ${state.wave + 1} IN ${Math.ceil(state.restTimer)}…`, 640, 200);
    }

    // Mute hint.
    ctx.textAlign = 'right';
    ctx.font = `600 12px ${FONT}`;
    ctx.fillStyle = 'rgba(154, 163, 192, 0.7)';
    ctx.fillText('P pause · M mute · R restart', 1256, 676);
  }

  function panel(x, y, w, h) {
    ctx.fillStyle = PALETTE.panel;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = PALETTE.panelEdge;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  }

  function drawTitle(state, best) {
    ctx.fillStyle = 'rgba(7, 9, 18, 0.45)';
    ctx.fillRect(0, 0, FIELD.width, FIELD.height);
    ctx.textAlign = 'center';
    ctx.fillStyle = PALETTE.lantern;
    ctx.font = `800 84px ${FONT}`;
    ctx.fillText('EMBERFALL', 640, 218);
    ctx.fillStyle = PALETTE.text;
    ctx.font = `600 26px ${FONT}`;
    ctx.fillText('— The Last Lantern —', 640, 262);
    ctx.fillStyle = PALETTE.muted;
    ctx.font = `400 18px ${FONT}`;
    ctx.fillText('The night is full of hungry dark. Keep the lantern burning.', 640, 302);
    ctx.fillText('Survive all five waves and fell the Ashen Maw.', 640, 330);

    panel(390, 372, 500, 168);
    ctx.fillStyle = PALETTE.text;
    ctx.font = `600 17px ${FONT}`;
    ctx.fillText('WASD / Arrows — move        Mouse — aim the burst', 640, 408);
    ctx.fillText('Lantern fires on its own        Space — dash', 640, 438);
    ctx.fillText('Gather ember shards — level up and choose a boon', 640, 468);
    ctx.fillText('P — pause        M — mute        R — restart', 640, 498);

    ctx.fillStyle = PALETTE.lantern;
    ctx.font = `800 24px ${FONT}`;
    ctx.fillText('Press SPACE or CLICK to begin', 640, 592);
    if (best > 0) {
      ctx.fillStyle = PALETTE.muted;
      ctx.font = `600 16px ${FONT}`;
      ctx.fillText(`Best score: ${best}`, 640, 626);
    }
  }

  function drawLevelUp(state) {
    const choices = state.levelChoices ?? [];
    ctx.fillStyle = 'rgba(7, 9, 18, 0.62)';
    ctx.fillRect(0, 0, FIELD.width, FIELD.height);
    ctx.textAlign = 'center';
    ctx.fillStyle = PALETTE.xp;
    ctx.font = `800 40px ${FONT}`;
    ctx.fillText('LEVEL UP — CHOOSE A BOON', 640, 150);
    ctx.fillStyle = PALETTE.muted;
    ctx.font = `400 17px ${FONT}`;
    ctx.fillText('Click a card, or press 1, 2 or 3.', 640, 184);

    const w = 280;
    const h = 240;
    const gap = 32;
    const total = choices.length * w + (choices.length - 1) * gap;
    let x = 640 - total / 2;
    const y = 240;
    choices.forEach((u, i) => {
      ctx.fillStyle = PALETTE.card;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = PALETTE.cardEdge;
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
      ctx.fillStyle = PALETTE.lantern;
      ctx.font = `400 54px ${FONT}`;
      ctx.fillText(u.icon, x + w / 2, y + 82);
      ctx.fillStyle = PALETTE.text;
      ctx.font = `800 21px ${FONT}`;
      ctx.fillText(u.name, x + w / 2, y + 128);
      ctx.fillStyle = PALETTE.muted;
      ctx.font = `400 15px ${FONT}`;
      wrapText(u.text, x + 18, y + 158, w - 36, 20);
      ctx.fillStyle = PALETTE.cardEdge;
      ctx.font = `800 16px ${FONT}`;
      ctx.fillText(`[${i + 1}]`, x + w / 2, y + h - 20);
      x += w + gap;
    });
  }

  function wrapText(text, x, y, maxWidth, lineHeight) {
    const words = text.split(' ');
    let line = '';
    let yy = y;
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        ctx.fillText(line, x + maxWidth / 2, yy);
        line = word;
        yy += lineHeight;
      } else {
        line = test;
      }
    }
    if (line) ctx.fillText(line, x + maxWidth / 2, yy);
  }

  function drawPaused() {
    ctx.fillStyle = 'rgba(7, 9, 18, 0.6)';
    ctx.fillRect(0, 0, FIELD.width, FIELD.height);
    ctx.textAlign = 'center';
    ctx.fillStyle = PALETTE.text;
    ctx.font = `800 52px ${FONT}`;
    ctx.fillText('PAUSED', 640, 330);
    ctx.fillStyle = PALETTE.muted;
    ctx.font = `400 18px ${FONT}`;
    ctx.fillText('P or Space to keep playing — R to start over', 640, 372);
  }

  function drawEnd(state, best, victory) {
    ctx.fillStyle = victory ? 'rgba(20, 26, 10, 0.55)' : 'rgba(18, 7, 12, 0.6)';
    ctx.fillRect(0, 0, FIELD.width, FIELD.height);
    ctx.textAlign = 'center';
    if (victory) {
      ctx.fillStyle = PALETTE.lantern;
      ctx.font = `800 64px ${FONT}`;
      ctx.fillText('DAWN BREAKS', 640, 220);
      ctx.fillStyle = PALETTE.text;
      ctx.font = `600 24px ${FONT}`;
      ctx.fillText('The Ashen Maw is fallen. The lantern burns on.', 640, 266);
    } else {
      ctx.fillStyle = PALETTE.danger;
      ctx.font = `800 64px ${FONT}`;
      ctx.fillText('THE LIGHT FADES', 640, 220);
      ctx.fillStyle = PALETTE.text;
      ctx.font = `600 24px ${FONT}`;
      ctx.fillText('The dark takes the lantern… this time.', 640, 266);
    }
    panel(440, 310, 400, 190);
    ctx.fillStyle = PALETTE.text;
    ctx.font = `800 30px ${FONT}`;
    ctx.fillText(`SCORE  ${state.score}`, 640, 366);
    ctx.font = `600 18px ${FONT}`;
    ctx.fillStyle = PALETTE.muted;
    ctx.fillText(`Best  ${best}`, 640, 400);
    const mins = Math.floor(state.time / 60);
    const secs = Math.floor(state.time % 60);
    ctx.fillText(`Wave ${state.wave} of ${WAVES}  ·  ${state.kills} felled  ·  ${mins}:${String(secs).padStart(2, '0')}`, 640, 432);
    ctx.fillText(`Level ${state.level}`, 640, 462);
    ctx.fillStyle = PALETTE.lantern;
    ctx.font = `800 22px ${FONT}`;
    ctx.fillText('Press SPACE or CLICK to play again', 640, 560);
  }

  function draw(state, screen, best) {
    const scale = Math.min(canvas.width / FIELD.width, canvas.height / FIELD.height);
    const ox = (canvas.width - FIELD.width * scale) / 2;
    const oy = (canvas.height - FIELD.height * scale) / 2;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width / DPR, canvas.height / DPR);
    ctx.setTransform(DPR * scale, 0, 0, DPR * scale, DPR * ox, DPR * oy);

    // Screen shake, from the world's own shake value.
    if (state.shake > 0) {
      const s = state.shake;
      ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    }

    drawBackground(state);
    for (const s of state.shards) if (s.active) drawShard(s, state.time);
    for (const b of state.bolts) {
      if (!b.active) continue;
      if (b.enemy) {
        circle(b.x, b.y, b.radius + 3, 'rgba(79, 195, 247, 0.35)');
        circle(b.x, b.y, b.radius, '#4fc3f7');
      } else {
        circle(b.x, b.y, b.radius + 3, 'rgba(255, 207, 92, 0.35)');
        circle(b.x, b.y, b.radius, '#ffcf5c');
        circle(b.x, b.y, 2, '#fff3c4');
      }
    }
    for (const e of state.enemies) if (e.active) drawEnemy(e, state.time);
    drawPlayer(state);
    drawParticles(state);
    // Floating combat text is part of play, not of the end screens: the
    // victory and game-over panels carry their own words.
    if (screen !== SCREEN_VICTORY && screen !== SCREEN_OVER) drawTexts(state);

    // A red flash when the keeper is hurt.
    if (state.flash > 0) {
      ctx.fillStyle = `rgba(255, 93, 115, ${state.flash * 0.45})`;
      ctx.fillRect(0, 0, FIELD.width, FIELD.height);
    }

    if (screen === SCREEN_TITLE) drawTitle(state, best);
    if (screen === SCREEN_PLAY || screen === SCREEN_LEVEL || screen === SCREEN_PAUSED) drawHud(state, screen);
    if (screen === SCREEN_LEVEL) drawLevelUp(state);
    if (screen === SCREEN_PAUSED) drawPaused();
    if (screen === SCREEN_VICTORY) drawEnd(state, best, true);
    if (screen === SCREEN_OVER) drawEnd(state, best, false);
  }

  return { draw };
}
