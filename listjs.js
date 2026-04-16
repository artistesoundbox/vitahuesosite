console.log("JS LOADED!");

window.addEventListener("DOMContentLoaded", () => {

  const circle = document.querySelector('.circle');
  const dots = document.querySelectorAll('.dot');
  const audio = document.getElementById('player');
  const label = document.getElementById('track-label');

  const trackNames = [
    "I see God in you",
    "You're Allowed to Rest",
    "The Mind Lies, The Heart Knows",
    "Tell Them While They're Here",
    "I Forgive You, I Forgive Me",
    "The Inner Child Still Matters",
    "You're Not Too Late",
    "Your Heart Is Still Good",
    "Thank You for Carrying Me",
    "Let Go of What's Killing You",
    "I'm Proud of You",
    "We're All Just Trying to Come Home"
  ];

  // ⭐ PERFECT DOT PLACEMENT
  const circleSize = 300;          // matches your CSS
  const center = circleSize / 2;   // 150
  const radius = 130;              // distance from center to dots

  dots.forEach((dot, i) => {
    const angle = (i / dots.length) * 2 * Math.PI;

    const x = center + radius * Math.cos(angle);
    const y = center + radius * Math.sin(angle);

    dot.style.left = `${x}px`;
    dot.style.top = `${y}px`;
  });

  // ⭐ Activate a dot
  function setActiveDot(index) {
    dots.forEach(d => d.classList.remove('active'));
    const dot = dots[index];
    dot.classList.add('active');

    const step = 360 / dots.length;
    const rotation = -step * index;
    circle.style.transform = `rotate(${rotation}deg)`;

    const src = dot.dataset.src;
    audio.src = src;
    label.textContent = trackNames[index];
    audio.play();
  }

  // ⭐ Click listeners
  dots.forEach(dot => {
    dot.addEventListener('click', () => {
      const index = Number(dot.dataset.index);
      console.log("Clicked index:", index);
      setActiveDot(index);
    });
  });

  // ⭐ Start on track 0
  setActiveDot(0);

});
