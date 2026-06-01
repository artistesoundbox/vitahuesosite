const modGain = audioCtx.createGain();
      droneGain = audioCtx.createGain();
      droneOsc.type = "sawtooth";
      droneOsc.frequency.value = 82;
      mod.frequency.value = 0.08;
      modGain.gain.value = 12;
      mod.connect(modGain);
      modGain.connect(droneOsc.frequency);
      droneGain.gain.value = 0;
      droneOsc.connect(droneGain);
      droneGain.connect(master);
      droneOsc.start();
      mod.start();
    }

    function ping(freq = 440, type = "triangle", duration = .18) {
      if (!audioOn) return;
      ensureAudio();
      audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(.0001, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(.22, audioCtx.currentTime + .012);
      gain.gain.exponentialRampToValueAtTime(.0001, audioCtx.currentTime + duration);
      osc.connect(gain);
      gain.connect(master);
      osc.start();
      osc.stop(audioCtx.currentTime + duration + .02);
    }

    function setPlaying(next) {
      playing = next;
      ensureAudio();
      audioCtx.resume();
      if (playing) {
        startedAt = performance.now() - elapsed;
        droneGain.gain.cancelScheduledValues(audioCtx.currentTime);
        droneGain.gain.linearRampToValueAtTime(.11, audioCtx.currentTime + .35);
        playIcon.innerHTML = '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>';
        showToast("Soundbox online");
      } else {
        elapsed = performance.now() - startedAt;
        droneGain.gain.cancelScheduledValues(audioCtx.currentTime);
        droneGain.gain.linearRampToValueAtTime(.0001, audioCtx.currentTime + .2);
        playIcon.innerHTML = '<path d="M8 5v14l11-7Z"/>';
        showToast("Soundbox paused");
      }
    }

    function tickTime() {
      if (playing) elapsed = performance.now() - startedAt;
      const total = Math.floor(elapsed / 1000);
      time.textContent = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
      requestAnimationFrame(tickTime);
    }

    function showToast(message) {
      toast.textContent = message;
      toast.classList.add("show");
      clearTimeout(showToast.t);
      showToast.t = setTimeout(() => toast.classList.remove("show"), 1600);
    }

    function updateTarget(x, y) {
      const rect = viewport.getBoundingClientRect();
      const size = target.offsetWidth;
      const nx = Math.max(0, Math.min(rect.width - size, x - rect.left - size / 2));
      const ny = Math.max(0, Math.min(rect.height - size, y - rect.top - size / 2));
      target.style.left = `${nx}px`;
      target.style.top = `${ny}px`;
      droneOsc && (droneOsc.frequency.value = 68 + (nx / rect.width) * 80);
    }

    let dragging = false;
    target.addEventListener("pointerdown", (event) => {
      dragging = true;
      target.setPointerCapture(event.pointerId);
      ping(720, "square", .08);
    });

    target.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      updateTarget(event.clientX, event.clientY);
    });

    target.addEventListener("pointerup", () => {
      dragging = false;
      hits += 1;
      counter.textContent = hits;
      ping(260 + hits * 21, "triangle", .16);
    });

    viewport.addEventListener("click", (event) => {
      if (event.target === target) return;
      updateTarget(event.clientX, event.clientY);
      hits += 1;
      counter.textContent = hits;
      ping(520 + Math.random() * 220, "sine", .13);
    });

    viewport.addEventListener("wheel", (event) => {
      event.preventDefault();
      zoom = Math.max(.6, Math.min(1.9, zoom + (event.deltaY < 0 ? .08 : -.08)));
      showToast(`Zoom ${Math.round(zoom * 100)}%`);
    }, { passive: false });

    play.addEventListener("click", () => setPlaying(!playing));

    audioToggle.addEventListener("click", () => {
      audioOn = !audioOn;
      audioToggle.classList.toggle("off", !audioOn);
      if (!audioOn && droneGain) droneGain.gain.linearRampToValueAtTime(.0001, audioCtx.currentTime + .15);
      if (audioOn && playing && droneGain) droneGain.gain.linearRampToValueAtTime(.11, audioCtx.currentTime + .25);
      showToast(audioOn ? "Audio enabled" : "Audio muted");
    });

    micToggle.addEventListener("click", () => {
      micOn = !micOn;
      micToggle.classList.toggle("off", !micOn);
      showToast(micOn ? "Mic channel armed" : "Mic channel muted");
      ping(micOn ? 880 : 330, "triangle", .11);
    });

    document.getElementById("composer").addEventListener("submit", (event) => {
      event.preventDefault();
      const text = prompt.value.trim();
      if (!text) {
        showToast("Give Producer a cue first");
        return;
      }
      thought.textContent = `Producer patched the array: "${text}" now modulates the particle field, target lock, and plasma bus.`;
      prompt.value = "";
      hits += 3;
      counter.textContent = hits;
      ping(660, "sawtooth", .2);
      showToast("Producer cue applied");
    });

    window.addEventListener("resize", resize);
    resize();
    requestAnimationFrame(draw);
    tickTime();
  </script>
</body>
</html>