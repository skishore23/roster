import Mathlib.Data.Nat.Prime.Infinite

theorem infinitely_many_primes : ∀ n : Nat, ∃ p > n, Nat.Prime p := by
  intro n
  rcases Nat.exists_infinite_primes (n + 1) with ⟨p, hp_ge, hp_prime⟩
  exact ⟨p, Nat.lt_of_succ_le (by simpa [Nat.succ_eq_add_one] using hp_ge), hp_prime⟩

namespace EuclidNat

end EuclidNat
