# Balls & Bricks

Static, dependency-free brick-shooter for mobile and desktop. Open `index.html` (or serve the folder with any static host, e.g. GitHub Pages).

**Play:** touch and drag: the aim line runs from the ball through your finger and stays visible between shots; release to fire. Clear bricks before they reach the bottom row; green rings add a ball. Use the 1×/3× button to fast-forward. Progress is saved in `localStorage`.

**Powerups** (hit them with a ball): 💥 orange = bomb (3×3 area), blue ↔ = whole row, purple ↕ = whole column. Damage scales with the round.
**Bosses:** every 5th round a wide boss block with lots of HP appears; killing it gives +3 balls.
**Reset:** the ↻ button in the top bar (asks for confirmation).
**Acid blocks:** with more than 80 balls, some blocks (20%) are covered in acid. The first ball to touch one is dissolved for good, then it becomes a normal block.
**Boss HP** = ball count × 8–17, with a 1-in-20 chance of ×18.
**Hard mode** (pick it in the new-game dialog, ↻): acid from just 20 balls (35% of blocks), a boss every 2nd round, blocks with double HP, bosses never below round×20 HP, and more powerups. Designed to be near-impossible without powerups. Best score is tracked separately.
