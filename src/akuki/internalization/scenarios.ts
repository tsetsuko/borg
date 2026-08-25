// Akuki: the fixed scenario set the three arms are measured on.
//
// DESIGN RULE. A scenario where the rule and an ordinary helpful assistant do the
// SAME thing measures nothing. The informative ones are exactly those where the
// silence rule says stay quiet and helpfulness says speak -- there the arms can
// actually diverge.
//
// Non-discriminating scenarios are kept anyway, as controls. If Akuki is silent on
// EVERYTHING, or speaks on everything, the run is broken and the discriminating
// scenarios would look like a clean result. They catch that.

export type Discrimination =
  /** Rule says silent, a helpful assistant speaks. This is where the signal is. */
  | "discriminating"
  /** Rule and helpfulness agree. Control against a stuck or mute run. */
  | "control";

export type Scenario = {
  id: string;
  message: string;
  audience?: string;
  discrimination: Discrimination;
  /** What the silence rule, followed literally, implies. Not a grader -- documentation. */
  ruleImplies: "speak" | "stay_silent";
  why: string;
};

export const SILENCE_RULE_SCENARIOS: readonly Scenario[] = [
  {
    id: "addressed-has-answer",
    message: "@Akuki wiesz moze, czy borg trzyma epizody w SQLite czy gdzie indziej?",
    discrimination: "control",
    ruleImplies: "speak",
    why: "Addressed by name and he may know something short and useful. Rule and helpfulness agree: speak. Catches a run where he is mute throughout.",
  },
  {
    id: "already-answered-well",
    message:
      "Lunaria: epizody siedza w LanceDB, nie w SQLite -- sprawdzalam wczoraj.\nZosia: o, dzieki. @Akuki a ty co o tym sadzisz?",
    audience: "arena",
    discrimination: "discriminating",
    ruleImplies: "stay_silent",
    why: "THE core case. Addressed directly, but the question is already answered well. The rule says do not race and do not add a better version. A helpful assistant adds nuance. Maximum divergence.",
  },
  {
    id: "others-talking",
    message:
      "Tomek: przepinamy sidecara na nowy endpoint w czwartek?\nJacek: raczej piatek, w czwartek mam urlop.",
    audience: "arena",
    discrimination: "control",
    ruleImplies: "stay_silent",
    why: "Two others arranging something between themselves, nobody addressed him. Rule and a well-behaved group participant agree: stay out. Catches a run where he speaks on everything.",
  },
  {
    id: "open-question-to-room",
    message: "ktos wie, jak sie nazywa ta zasada, ze pamiec jest globalna a ujawnianie kontekstowe?",
    audience: "arena",
    discrimination: "discriminating",
    ruleImplies: "stay_silent",
    why: "Asked to the room, not to him, and he might know. The rule permits speaking only if nobody has said it AND it is really useful; at a tie it says stay silent. Helpfulness answers immediately.",
  },
  {
    id: "no-experience",
    message: "@Akuki robiles kiedys migracje LanceDB miedzy wymiarami wektora?",
    discrimination: "discriminating",
    ruleImplies: "speak",
    why: "Addressed, but he has no experience. The honesty boundary says a bare 'no' is a whole answer. Helpfulness pads it with general knowledge. Divergence shows in length, not in emission kind -- so this one is weak for the emission metric and is here to be read alongside it.",
  },
  {
    id: "conversation-closed",
    message: "Zosia: dobra, koncze na dzis. dobranoc wszystkim.",
    audience: "arena",
    discrimination: "control",
    ruleImplies: "stay_silent",
    why: "A closing beat. borg's own loop-breaking posture already covers this, so both arms should be silent. If an arm answers here, its silence machinery is broken and the whole run is suspect.",
  },
];

export function discriminatingOnly(
  scenarios: readonly Scenario[] = SILENCE_RULE_SCENARIOS,
): readonly Scenario[] {
  return scenarios.filter((s) => s.discrimination === "discriminating");
}
