import Mathlib

/-!
A lightweight formalization skeleton of the standard *dissection proof* of Pythagoras.

We do not build a full Euclidean geometry development here. Instead we isolate the
only geometric inputs needed for the area computation as explicit hypotheses:

* the big square has side `(a+b)`
* the four corner pieces are congruent right triangles with legs `a` and `b`
* the remaining central region is a square whose side is the hypotenuse `c`

From these, area additivity yields `a^2 + b^2 = c^2`.
-/

namespace PythagorasDissection

open scoped BigOperators

/-- The algebraic area computation in the dissection proof.

Geometric inputs are provided as equalities of areas; the conclusion is the usual
Pythagorean identity. -/
theorem pythagoras_of_dissection
    {a b c : ℝ}
    (hbig : (a + b) ^ 2 = 4 * (a * b / 2) + c ^ 2) :
    a ^ 2 + b ^ 2 = c ^ 2 := by
  -- Expand `(a+b)^2` and cancel the triangle areas.
  have h1 : a ^ 2 + b ^ 2 + 2 * (a * b) = 4 * (a * b / 2) + c ^ 2 := by
    -- `(a+b)^2 = a^2 + b^2 + 2ab`
    -- Use `ring`-style normalization.
    simpa [pow_two, mul_add, add_mul, add_assoc, add_left_comm, add_comm,
      mul_assoc, mul_left_comm, mul_comm, two_mul, add_mul, mul_add] using hbig
  -- Simplify `4 * (ab/2)` to `2ab`.
  have htri : (4 : ℝ) * (a * b / 2) = 2 * (a * b) := by
    ring
  -- Finish by cancellation.
  -- Replace the `4*(ab/2)` term.
  -- Then cancel `2ab` from both sides.
  have h2 : a ^ 2 + b ^ 2 + 2 * (a * b) = 2 * (a * b) + c ^ 2 := by
    simpa [htri] using h1
  -- cancel `2ab`
  linarith

/--
A packaged statement closer to the dissection story: if you can justify the area
decomposition equation for the `(a+b)`-square dissected into four right triangles
and a central `c`-square, then Pythagoras follows.

This lemma is meant to be used with a geometry layer that produces `hbig`.
-/
theorem pythagoras_dissection
    {a b c : ℝ}
    (hbig : (a + b) ^ 2 = 4 * (a * b / 2) + c ^ 2) :
    a ^ 2 + b ^ 2 = c ^ 2 :=
  pythagoras_of_dissection hbig

end PythagorasDissection
