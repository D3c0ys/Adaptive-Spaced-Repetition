"""
Adaptive Forgetting Curve Spaced Repetition Simulator
-------------------------------------------------------
Models a single note's recall probability over time using:

    n(t) = exp(-theta * (t - t_last))

where theta (forgetting rate) adapts after every review:
    - success -> theta *= ALPHA   (theta shrinks, memory strengthens, gaps grow)
    - failure -> theta *= BETA    (theta grows, memory weaker, gaps shrink)

The next review is scheduled for the day n(t) is predicted to
drop to a chosen THRESHOLD (e.g. 0.90 recall probability).

Edit the OUTCOMES list below to simulate different review results
("pass" / "fail") and see how the schedule and curve respond.
"""

import numpy as np
import matplotlib.pyplot as plt
from matplotlib.dates import DateFormatter
from datetime import datetime, timedelta

# ----------------------------- CONFIG -----------------------------

START_DATE = datetime(2026, 8, 2)   # note creation date
THETA_INIT = 0.05                   # initial forgetting rate (guess)
THRESHOLD = 0.90                    # schedule next review when recall prob hits this
ALPHA = 0.70                        # theta multiplier on a successful recall (theta shrinks)
BETA = 1.60                         # theta multiplier on a failed recall (theta grows)
THETA_CAP = THETA_INIT              # failed reviews never push theta above the initial guess

# Simulated review outcomes, one per scheduled review.
# "pass" = recalled well, "fail" = struggled / forgot.
# Add/remove entries to simulate more or fewer review cycles.
OUTCOMES = ["pass", "pass", "fail", "pass", "pass", "pass"]

# --------------------------- SIMULATION ----------------------------

def gap_days(theta, threshold=THRESHOLD):
    """Days until recall probability decays to `threshold`, given rate theta."""
    return -np.log(threshold) / theta


def simulate(start_date, theta_init, outcomes):
    """Run the review schedule forward and return event log + curve segments."""
    events = []  # (date, theta_used, days_until_next)
    segments = []  # list of (t_start, t_end, theta) for plotting each decay segment

    theta = theta_init
    t_last = start_date

    for outcome in outcomes:
        dt = gap_days(theta)
        t_next = t_last + timedelta(days=dt)

        events.append({
            "review_date": t_last,
            "theta_used": theta,
            "gap_days": dt,
            "next_review": t_next,
            "outcome": outcome,
        })
        segments.append((t_last, t_next, theta))

        # update theta based on outcome, for the *next* segment
        if outcome == "pass":
            theta = theta * ALPHA
        else:
            theta = min(theta * BETA, THETA_CAP)

        t_last = t_next

    # one final segment showing the curve after the last review (open-ended)
    segments.append((t_last, t_last + timedelta(days=gap_days(theta)), theta))

    return events, segments


def build_curve(segments, points_per_day=4):
    """Turn the piecewise segments into dense (date, n(t)) arrays for plotting."""
    all_dates, all_n = [], []
    for t_start, t_end, theta in segments:
        n_points = max(int((t_end - t_start).days * points_per_day), 2)
        t_days = np.linspace(0, (t_end - t_start).days, n_points)
        dates = [t_start + timedelta(days=float(d)) for d in t_days]
        n_vals = np.exp(-theta * t_days)
        all_dates.extend(dates)
        all_n.extend(n_vals)
    return all_dates, all_n


# ------------------------------ PLOT --------------------------------

def plot(events, segments, threshold):
    dates, n_vals = build_curve(segments)

    fig, ax = plt.subplots(figsize=(11, 6))
    ax.plot(dates, n_vals, color="#3B6EBF", linewidth=2, label="Recall probability n(t)")
    ax.axhline(threshold, color="gray", linestyle="--", linewidth=1,
               label=f"Review threshold ({threshold:.0%})")

    # mark each review event
    for e in events:
        color = "#2E9E5B" if e["outcome"] == "pass" else "#D14343"
        marker = "o" if e["outcome"] == "pass" else "X"
        ax.scatter(e["review_date"], 1.0, color=color, marker=marker, s=90, zorder=5)
        ax.annotate(
            f"{e['review_date'].strftime('%d/%m')}\nθ={e['theta_used']:.4f}",
            xy=(e["review_date"], 1.0),
            xytext=(0, 14), textcoords="offset points",
            ha="center", fontsize=8, color="#333333",
        )

    ax.set_ylim(0, 1.08)
    ax.set_ylabel("Recall probability  n(t)")
    ax.set_xlabel("Date")
    ax.set_title("Adaptive Forgetting Curve — Spaced Repetition Schedule")
    ax.xaxis.set_major_formatter(DateFormatter("%d/%m"))
    fig.autofmt_xdate()

    # legend with pass/fail markers
    from matplotlib.lines import Line2D
    handles, labels = ax.get_legend_handles_labels()
    handles += [
        Line2D([0], [0], marker="o", color="w", markerfacecolor="#2E9E5B", markersize=9, label="Review: pass"),
        Line2D([0], [0], marker="X", color="w", markerfacecolor="#D14343", markersize=9, label="Review: fail"),
    ]
    ax.legend(handles=handles, loc="lower left", fontsize=9)

    ax.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig("/mnt/user-data/outputs/forgetting_curve_schedule.png", dpi=150)
    print("Saved plot to /mnt/user-data/outputs/forgetting_curve_schedule.png")


def print_schedule(events):
    print(f"{'Review date':<14}{'theta':<10}{'gap (days)':<12}{'next review':<14}{'outcome'}")
    for e in events:
        print(f"{e['review_date'].strftime('%d/%m/%y'):<14}"
              f"{e['theta_used']:<10.4f}"
              f"{e['gap_days']:<12.2f}"
              f"{e['next_review'].strftime('%d/%m/%y'):<14}"
              f"{e['outcome']}")


if __name__ == "__main__":
    events, segments = simulate(START_DATE, THETA_INIT, OUTCOMES)
    print_schedule(events)
    plot(events, segments, THRESHOLD)
