import { get, set } from "./lib/idb-keyval.js";
import { initHaptic, triggerHaptic } from "./haptic.js";

window.addEventListener("load", function () {
  const canvas = document.getElementById("scope");
  const ctx = canvas.getContext("2d");

  // --- CONFIG ---
  const POINTS = 100; // High resolution for complex waves
  let WIDTH, HEIGHT, SEGMENT_WIDTH, CENTER_Y, SCALE_Y;
  let zoomLevel = 1.0; // Zoom multiplier for signal amplitude

  // --- STATE ---
  let noiseSignal = new Array(POINTS).fill(0);
  let particles = [];
  let packet = { vals: [], xIndex: 0, yOffset: -150 };
  let isDropping = false;
  let gameRunning = false; // Start with game paused for splash
  let gameStarted = false;
  let isInverted = false; // Track if current wavelet is inverted

  // Animation state for signal merging
  let mergeAnimation = {
    active: false,
    frame: 0,
    totalFrames: 12,
    oldSignal: [],
    newSignal: [],
  };

  // Progression
  let score = 0;
  let complexity = 1; // Starts simple (1-2 bumps), scales up
  let lastRMS = 0;
  let rmsTrendTimer = 0;
  let invertCount = 5; // Limited invert uses

  // Preview queue - holds next 3 wavelets
  let waveletQueue = [];

  // Game mode state
  let gameMode = "endless"; // "endless" or "piece-based"
  let piecesRemaining = 120;
  let bestRMS = Infinity;

  // Track complexity threshold crossings for rewarding inverts
  let complexityThresholdsReached = {
    2.0: false,
    1.5: false,
    1.0: false,
    0.7: false,
    0.5: false,
  };

  // High scores - stored as array of {rms: number, date: timestamp}
  let highScores = [];

  // Load high scores from IndexedDB
  async function loadHighScores() {
    const scores = await get("highScores");
    highScores = scores || [];
  }

  // Save high scores to IndexedDB
  async function saveHighScores() {
    await set("highScores", highScores);
  }

  // Add a new score and keep only top 5
  async function addHighScore(rms) {
    highScores.push({ rms, date: Date.now() });
    // Sort by RMS ascending (lower is better)
    highScores.sort((a, b) => a.rms - b.rms);
    // Keep only top 5
    highScores = highScores.slice(0, 5);
    await saveHighScores();
  }

  // Format high scores for display
  function formatHighScores() {
    if (highScores.length === 0) {
      return "<p>No scores yet!</p>";
    }
    let html = "<ol>";
    highScores.forEach((score) => {
      const date = new Date(score.date);
      const dateStr = date.toLocaleDateString();
      html += `<li>${score.rms.toFixed(2)} <span class="score-date">(${dateStr})</span></li>`;
    });
    html += "</ol>";
    return html;
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    WIDTH = window.innerWidth;
    HEIGHT = window.innerHeight;

    SEGMENT_WIDTH = WIDTH / (POINTS - 1);
    CENTER_Y = HEIGHT * 0.6; // Move signal lower to make room for preview
    SCALE_Y = HEIGHT / 30;
  }
  window.addEventListener("resize", resize);
  resize();

  // --- PROCEDURAL GENERATION ---

  function generateNoise() {
    // The "Problem" to solve. Needs to be messy but solvable.
    let t = Date.now() * 0.001;
    for (let i = 0; i < POINTS; i++) {
      // Base Low Freq
      let val = Math.sin(i * 0.2 + t) * 3;
      // Mid Freq
      val += Math.sin(i * 0.7 - t) * 2;
      // High Freq Jitter
      val += (Math.random() - 0.5) * 1.5;
      noiseSignal[i] = val;
    }

    // Normalize to RMS = 2.5 for fair starting conditions
    let sumSq = 0;
    for (let i = 0; i < POINTS; i++) {
      sumSq += noiseSignal[i] * noiseSignal[i];
    }
    let currentRMS = Math.sqrt(sumSq / POINTS);
    let scaleFactor = 2.5 / currentRMS;

    for (let i = 0; i < POINTS; i++) {
      noiseSignal[i] *= scaleFactor;
    }
  }

  // Detect high-frequency content by measuring average absolute differences
  function getHighFrequencyMetric() {
    let sumDiff = 0;
    for (let i = 1; i < POINTS; i++) {
      sumDiff += Math.abs(noiseSignal[i] - noiseSignal[i - 1]);
    }
    return sumDiff / POINTS;
  }

  // Get current signal amplitude (RMS-based)
  function getSignalAmplitude() {
    let sumSq = 0;
    for (let i = 0; i < POINTS; i++) {
      sumSq += noiseSignal[i] * noiseSignal[i];
    }
    return Math.sqrt(sumSq / POINTS);
  }

  function createProceduralPacket(maxLvl) {
    // "The more there are the harder it is"
    // Lvl 1: Width ~10, 1-2 peaks.
    // Lvl 5: Width ~30, multiple peaks/valleys.

    // Detect if signal has high-frequency content
    const hfMetric = getHighFrequencyMetric();
    const isHighFrequency = hfMetric > 0.3; // Threshold for "jumpy" signal

    // Detect low RMS - need simpler, more targeted pieces
    const currentRMS = getSignalAmplitude();
    const isLowRMS = currentRMS < 0.5;

    // If high-frequency or low RMS, bias toward simpler, narrower pieces
    let lvl;
    if (isHighFrequency && Math.random() < 0.6) {
      // 60% chance of generating a simple narrow bump
      lvl = 1;
    } else if (isLowRMS && Math.random() < 0.7) {
      // 70% chance of simple pieces at low RMS
      lvl = 1;
    } else {
      // Normal variety: choose from 1 to maxLvl
      lvl = 1 + Math.floor(Math.random() * maxLvl);
    }

    const width = Math.min(60, 12 + lvl * 4);
    const arr = [];

    // Random characteristics
    const freq = 0.3 + Math.random() * 0.5; // How wiggly
    const phase = Math.random() * Math.PI * 2;
    const harmonics = 1 + Math.floor(lvl / 3); // Add extra sine waves at higher levels

    // At low RMS, make pieces cleaner (more delta-like, single frequency)
    const noiseAmount = isLowRMS ? 0.05 : 0.15;
    const highFreqAmount = isLowRMS ? 0.03 : 0.1;

    for (let i = 0; i < width; i++) {
      // Window Function (Hanning) to ensure ends taper to 0 smoothly
      // This creates a "Packet" rather than a hard cut signal
      const window = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (width - 1)));

      let val = Math.sin(i * freq + phase);

      // Add jaggedness/harmonics (skip at low RMS for cleaner pieces)
      if (harmonics > 1 && !isLowRMS) {
        val += Math.sin(i * freq * 2.5) * 0.5;
      }

      // Add high-frequency components (reduced at low RMS for delta-like pieces)
      val += (Math.random() - 0.5) * noiseAmount;
      val += Math.sin(i * 1.8 + phase) * highFreqAmount;

      // Scale amplitude to match current signal
      // Use signal RMS but with a minimum floor to keep pieces usable
      const signalRMS = getSignalAmplitude();
      const targetAmp = Math.max(1.5, signalRMS * 1.2); // At least 1.5, or 120% of signal
      val *= targetAmp;

      // Apply window
      arr.push(val * window);
    }

    // Randomly flip the whole thing so we get valleys too
    if (Math.random() > 0.5) {
      for (let k = 0; k < arr.length; k++) arr[k] *= -1;
    }

    return arr;
  }

  function spawnPacket() {
    // Pull from queue or generate new if queue is empty
    if (waveletQueue.length > 0) {
      packet.vals = waveletQueue.shift(); // Take first from queue
    } else {
      packet.vals = createProceduralPacket(complexity);
    }

    // Add new wavelet to end of queue to maintain 3 ahead
    waveletQueue.push(createProceduralPacket(complexity));

    packet.xIndex = Math.floor(POINTS / 2) - Math.floor(packet.vals.length / 2);
    packet.yOffset = -HEIGHT * 0.3;
    isDropping = false;
    isInverted = false; // Reset inversion state for new wavelet
  }

  // --- ENGINE ---

  function update() {
    if (!gameRunning) return;

    // Update merge animation
    if (mergeAnimation.active) {
      mergeAnimation.frame++;
      const progress = mergeAnimation.frame / mergeAnimation.totalFrames;

      // Interpolate between old and new signal
      for (let i = 0; i < POINTS; i++) {
        noiseSignal[i] =
          mergeAnimation.oldSignal[i] +
          (mergeAnimation.newSignal[i] - mergeAnimation.oldSignal[i]) *
            progress;
      }

      if (mergeAnimation.frame >= mergeAnimation.totalFrames) {
        // Animation complete, snap to final values
        for (let i = 0; i < POINTS; i++) {
          noiseSignal[i] = mergeAnimation.newSignal[i];
        }
        mergeAnimation.active = false;
      }
    }

    // RMS & Clipping
    let sumSq = 0;
    let maxVal = 0;
    for (let i = 0; i < POINTS; i++) {
      let v = noiseSignal[i] || 0;
      sumSq += v * v;
      if (Math.abs(v) > maxVal) maxVal = Math.abs(v);
    }

    let rms = Math.sqrt(sumSq / POINTS);
    document.getElementById("noise-lvl").innerText = rms.toFixed(2);

    // Track best RMS for piece-based mode
    if (gameMode === "piece-based" && rms < bestRMS) {
      bestRMS = rms;
    }

    // Update trend indicator with persistence
    if (rmsTrendTimer > 0) {
      rmsTrendTimer--;
      if (rmsTrendTimer === 0) {
        document.getElementById("rms-trend").className = "rms-indicator";
      }
    }

    // Win/lose conditions depend on game mode
    if (gameMode === "endless") {
      // Win condition
      if (rms < 0.1) {
        gameWin();
      }

      // Game over conditions
      if (maxVal > 25 || rms > 5) {
        gameOver();
      }
    } else if (gameMode === "piece-based") {
      // Piece-based mode: end when pieces run out
      if (piecesRemaining <= 0) {
        gamePieceEnd();
      }

      // Still can fail if signal clips too hard
      if (maxVal > 25 || rms > 5) {
        gameOver();
      }
    }

    // Logic
    if (isDropping) {
      packet.yOffset += HEIGHT * 0.1; // Fast drop
      if (packet.yOffset >= 0) mergeSignal();
    }

    // Particles
    for (let i = particles.length - 1; i >= 0; i--) {
      let p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.life -= 0.05;
      if (p.life <= 0) particles.splice(i, 1);
    }
  }

  function mergeSignal() {
    // Consume invert use if the wavelet was inverted
    if (isInverted) {
      invertCount--;
      updateInvertButton();
      isInverted = false; // Reset flag after consuming
    }

    let maxImpact = 0;

    // Calculate RMS before merge
    let sumSqBefore = 0;
    for (let i = 0; i < POINTS; i++) {
      let v = noiseSignal[i] || 0;
      sumSqBefore += v * v;
    }
    let rmsBefore = Math.sqrt(sumSqBefore / POINTS);

    // Store old signal for animation
    mergeAnimation.oldSignal = [...noiseSignal];
    mergeAnimation.newSignal = [...noiseSignal];

    for (let i = 0; i < packet.vals.length; i++) {
      const idx = packet.xIndex + i;
      if (idx >= 0 && idx < POINTS) {
        const oldVal = noiseSignal[idx];
        mergeAnimation.newSignal[idx] += packet.vals[i];

        // Visual feedback: Calculate how much we reduced/increased the signal
        const delta =
          Math.abs(oldVal) - Math.abs(mergeAnimation.newSignal[idx]);

        // If delta is positive, we reduced noise (Good).
        // If negative, we added noise (Bad).
        if (delta > 0.5) {
          spawnParticle(
            idx * SEGMENT_WIDTH,
            CENTER_Y - mergeAnimation.newSignal[idx] * SCALE_Y,
            "#00ff00",
          ); // Green spark
        } else if (delta < -2) {
          spawnParticle(
            idx * SEGMENT_WIDTH,
            CENTER_Y - mergeAnimation.newSignal[idx] * SCALE_Y,
            "#ff0000",
          ); // Red spark
        }
      }
    }

    // Start animation
    mergeAnimation.active = true;
    mergeAnimation.frame = 0;

    // Calculate RMS after merge and set trend
    let sumSqAfter = 0;
    for (let i = 0; i < POINTS; i++) {
      let v = mergeAnimation.newSignal[i] || 0;
      sumSqAfter += v * v;
    }
    let rmsAfter = Math.sqrt(sumSqAfter / POINTS);

    const trendEl = document.getElementById("rms-trend");
    if (rmsAfter > rmsBefore) {
      trendEl.className = "rms-indicator iconoir-graph-up";
      trendEl.style.color = "#ff0000";
      rmsTrendTimer = 180; // Show for ~3 seconds at 60fps
    } else if (rmsAfter < rmsBefore) {
      trendEl.className = "rms-indicator iconoir-graph-down";
      trendEl.style.color = "#00ff00";
      rmsTrendTimer = 180; // Show for ~3 seconds at 60fps
    }
    lastRMS = rmsAfter;

    // Progression - complexity based on RMS reduction (both modes)
    score++;

    // Check if crossing thresholds (both directions) for invert rewards
    const thresholds = [2.0, 1.5, 1.0, 0.7, 0.5];
    for (const threshold of thresholds) {
      // Crossing downward (improvement)
      if (rmsBefore >= threshold && rmsAfter < threshold) {
        if (!complexityThresholdsReached[threshold]) {
          complexityThresholdsReached[threshold] = true;
          invertCount += 3;
          updateInvertButton();
        }
      }
      // Crossing back upward (returning to threshold after being below)
      if (rmsBefore < threshold && rmsAfter >= threshold) {
        // Give inverts if they had reached this threshold before
        if (complexityThresholdsReached[threshold]) {
          invertCount += 3;
          updateInvertButton();
        }
      }
    }

    // Increase complexity as player reduces RMS (same thresholds in both modes)
    if (rmsAfter < 2.0 && complexity === 1) {
      complexity = 2;
      document.getElementById("complexity-disp").innerText = complexity;
    } else if (rmsAfter < 1.5 && complexity === 2) {
      complexity = 3;
      document.getElementById("complexity-disp").innerText = complexity;
    } else if (rmsAfter < 1.0 && complexity === 3) {
      complexity = 4;
      document.getElementById("complexity-disp").innerText = complexity;
    } else if (rmsAfter < 0.7 && complexity === 4) {
      complexity = 5;
      document.getElementById("complexity-disp").innerText = complexity;
    } else if (rmsAfter < 0.5 && complexity === 5) {
      complexity = 6;
      document.getElementById("complexity-disp").innerText = complexity;
    }

    // Update pieces counter in piece-based mode
    if (gameMode === "piece-based") {
      piecesRemaining--;
      document.getElementById("pieces-remaining").innerText = piecesRemaining;

      // Give extra inverts every 50 pieces in piece-based mode
      const piecesUsed = 120 - piecesRemaining;
      if (piecesUsed > 0 && piecesUsed % 50 === 0) {
        invertCount += 3;
        updateInvertButton();
      }
    }

    spawnPacket();
  }

  function gameWin() {
    gameRunning = false;
    const piecesUsed = 120 - piecesRemaining;
    showGameMenu(`SILENCE ACHIEVED! (${piecesUsed} pieces used)`, "#00ff00");
  }

  function gameOver() {
    gameRunning = false;
    showGameMenu("OVERLOAD - SIGNAL CLIPPED", "red");
  }

  async function gamePieceEnd() {
    gameRunning = false;

    // Save the score
    await addHighScore(bestRMS);

    showGameMenu(
      `GAME OVER - Best RMS: ${bestRMS.toFixed(2)}`,
      bestRMS < 0.5 ? "#00ff00" : "#ffcc00",
    );
  }

  function showGameMenu(message, color) {
    const menuEl = document.getElementById("game-menu");
    const modeDisplayEl = document.getElementById("current-mode-display");
    modeDisplayEl.innerText =
      gameMode === "endless" ? "ENDLESS" : "PIECE-BASED";

    // Show message in menu
    let messageEl = document.getElementById("game-status-message");
    if (!messageEl) {
      messageEl = document.createElement("p");
      messageEl.id = "game-status-message";
      menuEl.insertBefore(messageEl, menuEl.children[1]);
    }
    messageEl.innerText = message;
    messageEl.style.color = color;

    // Show high scores if in piece-based mode
    const highScoresSection = document.getElementById("high-scores-section");
    const highScoresList = document.getElementById("high-scores-list");
    if (gameMode === "piece-based") {
      highScoresSection.style.display = "block";
      highScoresList.innerHTML = formatHighScores();
    } else {
      highScoresSection.style.display = "none";
    }

    menuEl.style.display = "block";
    document.getElementById("canvas-overlay").classList.add("active");
  }

  function hideGameMenu() {
    document.getElementById("game-menu").style.display = "none";
    document.getElementById("canvas-overlay").classList.remove("active");
  }

  function resetGame() {
    hideGameMenu();

    // Reset merge animation to prevent old clipped signal from being shown
    mergeAnimation.active = false;
    mergeAnimation.frame = 0;

    generateNoise();
    complexity = 1;
    score = 0;
    invertCount = 5;
    waveletQueue = [];
    bestRMS = Infinity;
    piecesRemaining = 120;

    // Reset threshold tracking
    complexityThresholdsReached = {
      2.0: false,
      1.5: false,
      1.0: false,
      0.7: false,
      0.5: false,
    };

    // Pre-fill queue with 3 wavelets
    for (let i = 0; i < 3; i++) {
      waveletQueue.push(createProceduralPacket(complexity));
    }
    spawnPacket();
    gameRunning = true;

    const statusEl = document.getElementById("status-display");
    statusEl.style.borderColor = "#33ff00";
    statusEl.style.color = "#33ff00";

    // Update or create complexity display
    let complexitySpan = document.getElementById("complexity-disp");
    if (!complexitySpan) {
      statusEl.innerHTML = "COMPLEXITY: ";
      complexitySpan = document.createElement("span");
      complexitySpan.id = "complexity-disp";
      statusEl.appendChild(complexitySpan);
    }
    complexitySpan.innerText = complexity;

    // Show/hide piece counter based on game mode
    let pieceCounter = document.getElementById("piece-counter");
    if (!pieceCounter) {
      pieceCounter = document.createElement("div");
      pieceCounter.id = "piece-counter";
      pieceCounter.style.display = "none";
      pieceCounter.innerHTML = 'PIECES: <span id="pieces-remaining">120</span>';
      statusEl.appendChild(pieceCounter);
    }

    if (gameMode === "piece-based") {
      pieceCounter.style.display = "block";
      document.getElementById("pieces-remaining").innerText = piecesRemaining;
    } else {
      pieceCounter.style.display = "none";
    }

    updateInvertButton();
  }

  function updateInvertButton() {
    const btn = document.getElementById("invert-btn");
    const countEl = document.getElementById("invert-count");
    countEl.innerText = invertCount;

    if (invertCount <= 0) {
      btn.classList.add("disabled");
    } else {
      btn.classList.remove("disabled");
    }
  }

  function invertWavelet() {
    if (invertCount <= 0 || !gameRunning || isDropping) return;

    triggerHaptic();

    // Toggle inversion state (can invert/uninvert freely)
    for (let i = 0; i < packet.vals.length; i++) {
      packet.vals[i] *= -1;
    }

    // Toggle the inverted flag
    isInverted = !isInverted;

    // Don't consume an invert use yet - only when dropping
  }

  function spawnParticle(x, y, color) {
    // Main particle
    particles.push({
      x: x,
      y: y,
      vx: (Math.random() - 0.5) * 10,
      vy: (Math.random() - 0.5) * 10,
      life: 1.0,
      size: 3,
      c: color,
    });

    // Add many smaller particles around it
    const smallParticleCount = 8 + Math.floor(Math.random() * 5);
    for (let i = 0; i < smallParticleCount; i++) {
      particles.push({
        x: x + (Math.random() - 0.5) * 10,
        y: y + (Math.random() - 0.5) * 10,
        vx: (Math.random() - 0.5) * 15,
        vy: (Math.random() - 0.5) * 15,
        life: 0.8 + Math.random() * 0.4,
        size: 0.5 + Math.random() * 1,
        c: color,
      });
    }
  }

  // --- RENDER ---
  // Catmull-Rom spline interpolation for smooth curves
  function catmullRom(p0, p1, p2, p3, t) {
    const v0 = (p2 - p0) * 0.5;
    const v1 = (p3 - p1) * 0.5;
    const t2 = t * t;
    const t3 = t * t2;
    return (
      (2 * p1 - 2 * p2 + v0 + v1) * t3 +
      (-3 * p1 + 3 * p2 - 2 * v0 - v1) * t2 +
      v0 * t +
      p1
    );
  }

  function drawLine(data, offsetY, color, width, glow) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = "round";
    ctx.shadowBlur = glow ? 5 : 0;
    ctx.shadowColor = color;
    ctx.beginPath();

    // Draw smooth curve using spline interpolation
    for (let i = 0; i < data.length - 1; i++) {
      const p0 = i > 0 ? data[i - 1] : data[i];
      const p1 = data[i];
      const p2 = data[i + 1];
      const p3 = i < data.length - 2 ? data[i + 2] : data[i + 1];

      const steps = 10; // Subdivisions between points for smoothness
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = (i + t) * SEGMENT_WIDTH;
        const interpolatedY = catmullRom(p0, p1, p2, p3, t);
        const y = CENTER_Y + offsetY - interpolatedY * SCALE_Y * zoomLevel;

        if (i === 0 && s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }

    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  function drawPacket() {
    // Draw the actual floating packet with smooth interpolation
    ctx.strokeStyle = "#ffcc00";
    ctx.lineWidth = 3;
    ctx.shadowBlur = 5;
    ctx.shadowColor = "#ffcc00";
    ctx.beginPath();

    for (let i = 0; i < packet.vals.length - 1; i++) {
      const p0 = i > 0 ? packet.vals[i - 1] : packet.vals[i];
      const p1 = packet.vals[i];
      const p2 = packet.vals[i + 1];
      const p3 =
        i < packet.vals.length - 2 ? packet.vals[i + 2] : packet.vals[i + 1];

      const steps = 10;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = (packet.xIndex + i + t) * SEGMENT_WIDTH;
        const interpolatedY = catmullRom(p0, p1, p2, p3, t);
        const y =
          CENTER_Y + packet.yOffset - interpolatedY * SCALE_Y * zoomLevel;

        if (i === 0 && s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }

    ctx.stroke();
    ctx.shadowBlur = 0;

    // Draw GHOST (Projection) with smooth interpolation
    ctx.strokeStyle = "rgba(255, 204, 0, 0.4)";
    ctx.save();
    ctx.setLineDash([2, 4]);
    ctx.lineWidth = 2;
    ctx.beginPath();

    for (let i = 0; i < packet.vals.length - 1; i++) {
      const p0 = i > 0 ? packet.vals[i - 1] : packet.vals[i];
      const p1 = packet.vals[i];
      const p2 = packet.vals[i + 1];
      const p3 =
        i < packet.vals.length - 2 ? packet.vals[i + 2] : packet.vals[i + 1];

      const steps = 10;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = (packet.xIndex + i + t) * SEGMENT_WIDTH;
        const interpolatedY = catmullRom(p0, p1, p2, p3, t);
        const y = CENTER_Y - interpolatedY * SCALE_Y * zoomLevel;

        if (i === 0 && s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }

    ctx.stroke();
    ctx.restore();
  }

  function drawPreview() {
    const previewX = 30; // Left side below RMS
    const startY = 80; // Start below HUD
    const boxSize = 60; // Size of each preview box
    const spacing = 70; // Vertical spacing between boxes

    for (let q = 0; q < Math.min(3, waveletQueue.length); q++) {
      const vals = waveletQueue[q];
      const boxY = startY + q * spacing;
      const centerY = boxY + boxSize / 2;

      // Draw box around next wavelet (index 0)
      if (q === 0) {
        ctx.strokeStyle = "#33ff00";
        ctx.lineWidth = 2;
        ctx.strokeRect(previewX, boxY, boxSize, boxSize);
      } else {
        ctx.strokeStyle = "rgba(51, 255, 0, 0.3)";
        ctx.lineWidth = 1;
        ctx.strokeRect(previewX, boxY, boxSize, boxSize);
      }

      // Find max amplitude to scale properly within the box
      let maxAmp = 0;
      for (let i = 0; i < vals.length; i++) {
        if (Math.abs(vals[i]) > maxAmp) maxAmp = Math.abs(vals[i]);
      }
      const previewScale = maxAmp > 0 ? (boxSize * 0.4) / maxAmp : 1;

      // Draw the wavelet inside the box
      ctx.strokeStyle = q === 0 ? "#ffcc00" : "rgba(255, 204, 0, 0.5)";
      ctx.lineWidth = q === 0 ? 2 : 1.5;
      ctx.beginPath();

      for (let i = 0; i < vals.length; i++) {
        const x = previewX + 5 + (i / vals.length) * (boxSize - 10);
        const y = centerY - vals[i] * previewScale;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  function loop() {
    ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // Amplitude scale markers (oscilloscope-style)
    ctx.save();
    ctx.strokeStyle = "#cc6600";
    ctx.lineWidth = 2;
    ctx.shadowBlur = 3;
    ctx.shadowColor = "#cc6600";
    ctx.globalAlpha = 0.4;

    // Center vertical line
    ctx.beginPath();
    ctx.moveTo(WIDTH / 2, 0);
    ctx.lineTo(WIDTH / 2, HEIGHT);
    ctx.stroke();

    // Amplitude markers on center line
    const markerSpacing = 20 * zoomLevel; // Spacing grows with zoom
    for (
      let offset = markerSpacing;
      offset < HEIGHT / 2;
      offset += markerSpacing
    ) {
      // Markers above center
      ctx.beginPath();
      ctx.moveTo(WIDTH / 2 - 10, CENTER_Y - offset);
      ctx.lineTo(WIDTH / 2 + 10, CENTER_Y - offset);
      ctx.stroke();

      // Markers below center
      ctx.beginPath();
      ctx.moveTo(WIDTH / 2 - 10, CENTER_Y + offset);
      ctx.lineTo(WIDTH / 2 + 10, CENTER_Y + offset);
      ctx.stroke();
    }

    // Zero Line (horizontal)
    ctx.beginPath();
    ctx.moveTo(0, CENTER_Y);
    ctx.lineTo(WIDTH, CENTER_Y);
    ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.restore();

    drawLine(noiseSignal, 0, "#33ff00", 2, true);
    if (gameRunning) {
      drawPacket();
      drawPreview();
    }

    particles.forEach(function (p) {
      ctx.fillStyle = p.c;
      ctx.globalAlpha = p.life;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size || 3, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1.0;
    update();
    requestAnimationFrame(loop);
  }

  // --- INPUT ---
  let startX = 0;
  let startY = 0;
  let isDragging = false;
  let isMouseDown = false;

  function inputStart(x, y) {
    startX = x;
    startY = y;
    isDragging = false;
    isMouseDown = true;
  }

  function inputMove(x) {
    if (!gameRunning || !isMouseDown) return;
    const diff = x - startX;
    if (Math.abs(diff) > 5) isDragging = true; // Small deadzone

    if (isDragging && !isDropping) {
      // Direct pixel-based movement - more responsive
      const pixelsMoved = diff;
      const segmentsToMove = Math.floor(
        Math.abs(pixelsMoved) / (SEGMENT_WIDTH * 0.3),
      );

      if (segmentsToMove > 0) {
        const dir = pixelsMoved > 0 ? 1 : -1;
        packet.xIndex += dir * segmentsToMove;

        // Bounds Check - allow dragging until half the wavelet is off-screen
        const halfWidth = Math.floor(packet.vals.length / 2);
        if (packet.xIndex < -halfWidth) packet.xIndex = -halfWidth;
        if (packet.xIndex + halfWidth > POINTS)
          packet.xIndex = POINTS - halfWidth;

        startX = x;
      }
    }
  }

  // Keyboard controls for desktop
  function moveWavelet(direction) {
    if (!gameRunning || isDropping) return;

    const moveAmount = 2; // Move by 2 segments per keypress
    packet.xIndex += direction * moveAmount;

    // Bounds Check
    const halfWidth = Math.floor(packet.vals.length / 2);
    if (packet.xIndex < -halfWidth) packet.xIndex = -halfWidth;
    if (packet.xIndex + halfWidth > POINTS) packet.xIndex = POINTS - halfWidth;
  }

  function dropWavelet() {
    if (!gameRunning || isDropping) return;
    isDropping = true;
    triggerHaptic();
  }

  // Zoom controls
  function adjustZoom(delta) {
    zoomLevel = Math.max(0.5, Math.min(5.0, zoomLevel + delta));
  }

  // Mouse wheel zoom
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      adjustZoom(delta);
    },
    { passive: false },
  );

  // Touch pinch zoom tracking
  let lastTouchDistance = 0;
  let isPinching = false;

  // Keyboard event handlers
  document.addEventListener("keydown", (e) => {
    if (
      !gameRunning &&
      e.key !== "+" &&
      e.key !== "=" &&
      e.key !== "-" &&
      e.key !== "_"
    )
      return;

    switch (e.key) {
      case "+":
      case "=":
        e.preventDefault();
        adjustZoom(0.1);
        break;
      case "-":
      case "_":
        e.preventDefault();
        adjustZoom(-0.1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        moveWavelet(-1);
        break;
      case "ArrowRight":
        e.preventDefault();
        moveWavelet(1);
        break;
      case " ": // Space bar
        e.preventDefault();
        dropWavelet();
        break;
      case "Shift":
        e.preventDefault();
        invertWavelet();
        break;
    }
  });

  function inputEnd(fromCanvas = true) {
    // Handle game over restart - now handled by menu buttons
    // if (!gameRunning) {
    //   resetGame();
    //   isDragging = false;
    //   isMouseDown = false;
    //   return;
    // }

    // Normal game input - only from canvas, and only tap (not drag) to drop
    if (fromCanvas && !isDragging && !isDropping && gameRunning) {
      isDropping = true;
      triggerHaptic();
    }
    isDragging = false;
    isMouseDown = false;
  }

  // Update splash screen high scores display
  function updateSplashHighScores() {
    const splashHighScores = document.getElementById("splash-high-scores");
    const splashHighScoresList = document.getElementById(
      "splash-high-scores-list",
    );

    if (highScores.length > 0) {
      splashHighScores.style.display = "block";
      splashHighScoresList.innerHTML = formatHighScores();
    } else {
      splashHighScores.style.display = "none";
    }
  }

  // Radio button haptic feedback
  const radioButtons = document.querySelectorAll('input[name="game-mode"]');
  radioButtons.forEach((radio) => {
    radio.addEventListener("change", () => {
      triggerHaptic();
    });
  });

  // Start button handler
  const startBtn = document.getElementById("start-btn");
  startBtn.addEventListener("click", () => {
    triggerHaptic();
    const modeRadio = document.querySelector('input[name="game-mode"]:checked');
    gameMode = modeRadio.value;
    document.getElementById("splash-screen").style.display = "none";
    document.getElementById("canvas-overlay").classList.remove("active");
    gameStarted = true;
    resetGame();
  });

  // Game menu handlers
  const restartBtn = document.getElementById("restart-btn");
  restartBtn.addEventListener("click", () => {
    triggerHaptic();
    resetGame();
  });

  const changeModeBtn = document.getElementById("change-mode-btn");
  changeModeBtn.addEventListener("click", () => {
    triggerHaptic();
    hideGameMenu();
    updateSplashHighScores();
    document.getElementById("splash-screen").style.display = "block";
    document.getElementById("canvas-overlay").classList.add("active");
  });

  const resumeBtn = document.getElementById("resume-btn");
  resumeBtn.addEventListener("click", () => {
    triggerHaptic();
    if (gameRunning) {
      hideGameMenu();
    }
  });

  // HUD click handlers to open menu
  const rmsDisplay = document.getElementById("rms-display");
  const statusDisplay = document.getElementById("status-display");

  rmsDisplay.addEventListener("click", (e) => {
    e.stopPropagation();
    triggerHaptic();
    if (gameRunning) {
      showGameMenu("PAUSED", "#ffcc00");
    }
  });

  statusDisplay.addEventListener("click", (e) => {
    e.stopPropagation();
    triggerHaptic();
    if (gameRunning) {
      showGameMenu("PAUSED", "#ffcc00");
    }
  });

  // Invert button handler
  const invertBtn = document.getElementById("invert-btn");
  invertBtn.addEventListener("click", invertWavelet);
  invertBtn.addEventListener("touchend", (e) => {
    e.preventDefault();
    invertWavelet();
  });

  function isClickOnHUD(x, y) {
    const rmsRect = rmsDisplay.getBoundingClientRect();
    const statusRect = statusDisplay.getBoundingClientRect();

    return (
      (x >= rmsRect.left &&
        x <= rmsRect.right &&
        y >= rmsRect.top &&
        y <= rmsRect.bottom) ||
      (x >= statusRect.left &&
        x <= statusRect.right &&
        y >= statusRect.top &&
        y <= statusRect.bottom)
    );
  }

  canvas.addEventListener("mousedown", (e) => {
    // Only handle left-click (button 0)
    if (e.button === 0 && !isClickOnHUD(e.clientX, e.clientY)) {
      inputStart(e.clientX, e.clientY);
    }
  });
  canvas.addEventListener(
    "touchstart",
    (e) => {
      // Handle pinch zoom with 2 fingers
      if (e.touches.length === 2) {
        isPinching = true;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        lastTouchDistance = Math.sqrt(dx * dx + dy * dy);
      } else if (e.touches.length === 1 && !isPinching) {
        // Normal single-finger input (only if not in pinch mode)
        if (!isClickOnHUD(e.touches[0].clientX, e.touches[0].clientY)) {
          inputStart(e.touches[0].clientX, e.touches[0].clientY);
        }
      }
    },
    { passive: false },
  );

  canvas.addEventListener("mousemove", (e) => {
    // Only handle movement during left-click drag
    if (e.buttons === 1) {
      inputMove(e.clientX);
    }
  });
  canvas.addEventListener(
    "touchmove",
    (e) => {
      e.preventDefault();

      // Handle pinch zoom with 2 fingers
      if (e.touches.length === 2) {
        isPinching = true;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (lastTouchDistance > 0) {
          const delta = (distance - lastTouchDistance) * 0.01;
          adjustZoom(delta);
        }

        lastTouchDistance = distance;
      } else if (e.touches.length === 1 && !isPinching) {
        // Normal single-finger drag (only if not in pinch mode)
        inputMove(e.touches[0].clientX);
      }
    },
    { passive: false },
  );

  canvas.addEventListener("mouseup", (e) => {
    // Only handle left-click release (button 0)
    if (e.button === 0 && !isClickOnHUD(e.clientX, e.clientY)) {
      inputEnd(true);
    }
  });
  canvas.addEventListener("touchend", (e) => {
    e.preventDefault();

    // Reset pinch zoom tracking when fingers lift
    if (e.touches.length < 2) {
      lastTouchDistance = 0;
    }

    // Handle normal touch end only if not in pinch mode
    if (e.touches.length === 0 && e.changedTouches.length > 0) {
      if (!isPinching) {
        const touch = e.changedTouches[0];
        if (!isClickOnHUD(touch.clientX, touch.clientY)) {
          inputEnd(true);
        }
      }
      // Reset pinch flag when all fingers are lifted
      isPinching = false;
    }
  });

  // Right-click to invert (canvas only)
  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    invertWavelet();
  });

  // Boot
  async function init() {
    initHaptic();
    await loadHighScores();
    updateSplashHighScores();

    // Activate overlay since splash screen is visible on load
    document.getElementById("canvas-overlay").classList.add("active");

    generateNoise();
    // Pre-fill queue with 3 wavelets
    for (let i = 0; i < 3; i++) {
      waveletQueue.push(createProceduralPacket(complexity));
    }
    spawnPacket();
    requestAnimationFrame(loop);
  }

  init();
});
