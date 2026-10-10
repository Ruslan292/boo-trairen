#!/usr/bin/env python3
"""Check manual difficult-question practice in the served trainer.

Run `npm start`, then:
  python3 tests/browser_difficult.py --base-url http://127.0.0.1:3000
Requires Python Playwright and Chromium, as does browser_smoke.py.
"""

import argparse

from playwright.sync_api import expect, sync_playwright

from browser_smoke import (
    ALL_QUESTIONS,
    FIRST,
    FIRST_TICKET_ID,
    SECOND,
    STORAGE_KEY,
    action,
    choose_answer,
    monitor,
    navigate,
    no_overflow,
    select_mode,
    stored,
    wait_home,
)


def bookmark(page, question):
    return action(page, "toggle-difficult", f'[data-question="{question["id"]}"]')


def remove_bookmark(page, question):
    return action(page, "remove-difficult", f'[data-question="{question["id"]}"]')


def new_page(browser, base_url, errors, mobile=False):
    context = browser.new_context(
        viewport={"width": 390 if mobile else 1440, "height": 844 if mobile else 1080},
        is_mobile=mobile,
        has_touch=mobile,
    )
    page = context.new_page()
    monitor(page, errors)
    page.goto(base_url)
    wait_home(page)
    return context, page


def resume_difficult(page):
    navigate(page, "difficult")
    action(page, "practice-difficult").click()


def marked_wrong_and_cycles_flow(browser, base_url, errors):
    context, page = new_page(browser, base_url, errors)
    page.locator('[data-setting="ticketId"]').select_option(FIRST_TICKET_ID)
    action(page, "start").click()
    choose_answer(page, FIRST, correct=False)
    action(page, "check").click()
    expect(page.locator(".feedback.negative")).to_be_visible()
    expect(bookmark(page, FIRST)).to_have_attribute("aria-pressed", "false")
    before_mark = stored(page, "learn")
    bookmark(page, FIRST).click()
    expect(bookmark(page, FIRST)).to_have_attribute("aria-pressed", "true")
    assert stored(page)["difficult"] == [FIRST["id"]]
    assert stored(page)["mistakes"] == [FIRST["id"]]
    assert stored(page, "learn") == before_mark, "Marking must not grade a question again"

    action(page, "next").click()
    expect(page.locator(".question-text")).to_have_text(SECOND["text"])
    bookmark(page, SECOND).click()
    choose_answer(page, SECOND)
    action(page, "check").click()
    assert stored(page)["difficult"] == [FIRST["id"], SECOND["id"]]
    learning = stored(page, "learn")
    page.reload()
    wait_home(page)
    assert stored(page)["difficult"] == [FIRST["id"], SECOND["id"]]

    # Existing error review still removes corrected questions automatically.
    navigate(page, "mistakes")
    expect(bookmark(page, FIRST)).to_have_attribute("aria-pressed", "true")
    action(page, "review").click()
    choose_answer(page, FIRST)
    action(page, "check").click()
    assert stored(page)["mistakes"] == []
    assert stored(page)["difficult"] == [FIRST["id"], SECOND["id"]]
    assert stored(page, "learn") == learning
    action(page, "next").click()
    expect(page.locator(".results h1")).to_be_visible()
    review = stored(page, "mistakes")

    navigate(page, "difficult")
    expect(page.locator(".list-question")).to_have_count(2)
    action(page, "practice-difficult").click()
    assert stored(page)["selectedMode"] == "difficult"
    for round_number in (1, 2):
        for question in (FIRST, SECOND):
            expect(page.locator(".question-text")).to_have_text(question["text"])
            expect(page.locator(".feedback")).to_have_count(0)
            session = stored(page, "difficult")["session"]
            assert session["round"] == round_number
            choose_answer(page, question)
            action(page, "check").click()
            expect(page.locator(".feedback.positive")).to_be_visible()
            assert stored(page)["difficult"] == [FIRST["id"], SECOND["id"]]
            action(page, "next").click()
            expect(page.locator(".results")).to_have_count(0)
    session = stored(page, "difficult")["session"]
    assert session["status"] == "active"
    assert session["round"] == 3
    assert session["index"] == 0
    assert session["responses"] == {} and session["checked"] == []
    assert stored(page, "difficult")["answers"] == {
        FIRST["id"]: {"attempts": 2, "correct": 2},
        SECOND["id"]: {"attempts": 2, "correct": 2},
    }
    assert stored(page, "learn") == learning
    assert stored(page, "mistakes") == review
    assert stored(page)["mistakes"] == []

    # Persist an unchecked choice, then persist checked feedback without regrading.
    wrong = choose_answer(page, FIRST, correct=False)
    selected = stored(page)
    page.reload()
    wait_home(page)
    resume_difficult(page)
    expect(page.locator(".question-text")).to_have_text(FIRST["text"])
    expect(page.locator(f'.answer.chosen[data-option="{wrong}"]')).to_be_visible()
    expect(page.locator(".feedback")).to_have_count(0)
    assert stored(page) == selected
    action(page, "check").click()
    expect(page.locator(".feedback.negative")).to_be_visible()
    checked = stored(page)
    assert checked["mistakes"] == [FIRST["id"]]
    assert checked["difficult"] == [FIRST["id"], SECOND["id"]]
    page.reload()
    wait_home(page)
    resume_difficult(page)
    expect(page.locator(".feedback.negative")).to_be_visible()
    assert stored(page) == checked, "Reloading checked feedback must not increase attempts"

    action(page, "next").click()
    expect(page.locator(".question-text")).to_have_text(SECOND["text"])
    choose_answer(page, SECOND)
    at_second = stored(page)
    assert at_second["modes"]["difficult"]["session"]["index"] == 1
    page.reload()
    wait_home(page)
    resume_difficult(page)
    expect(page.locator(".question-text")).to_have_text(SECOND["text"])
    expect(page.locator(".answer.chosen")).to_have_count(1)
    assert stored(page) == at_second, "Reload must preserve a nonzero question position and selected answer"
    action(page, "check").click()
    checked_second = stored(page)
    page.reload()
    wait_home(page)
    resume_difficult(page)
    expect(page.locator(".feedback.positive")).to_be_visible()
    assert stored(page) == checked_second
    action(page, "next").click()
    expect(page.locator(".question-text")).to_have_text(FIRST["text"])

    # Removing the current question keeps the other question and the error queue.
    navigate(page, "difficult")
    remove_bookmark(page, FIRST).click()
    expect(page.locator(".list-question")).to_have_count(1)
    assert stored(page)["difficult"] == [SECOND["id"]]
    assert stored(page)["mistakes"] == [FIRST["id"]]
    action(page, "practice-difficult").click()
    expect(page.locator(".question-text")).to_have_text(SECOND["text"])
    assert stored(page, "difficult")["session"]["questionIds"] == [SECOND["id"]]
    single_round = stored(page, "difficult")["session"]["round"]
    choose_answer(page, SECOND)
    action(page, "check").click()
    action(page, "next").click()
    expect(page.locator(".question-text")).to_have_text(SECOND["text"])
    expect(page.locator(".feedback, .results")).to_have_count(0)
    assert stored(page, "difficult")["session"]["round"] == single_round + 1
    assert stored(page)["difficult"] == [SECOND["id"]]
    navigate(page, "difficult")
    remove_bookmark(page, SECOND).click()
    expect(page.locator(".empty-state")).to_be_visible()
    expect(action(page, "practice-difficult")).to_have_count(0)
    assert stored(page)["difficult"] == []
    assert stored(page, "difficult")["session"] is None
    assert stored(page)["mistakes"] == [FIRST["id"]]
    assert stored(page, "learn") == learning
    assert stored(page, "mistakes") == review
    page.reload()
    wait_home(page)
    assert stored(page)["difficult"] == []
    assert stored(page)["mistakes"] == [FIRST["id"]]
    print("PASS manual marks coexist with errors; correction preserves marks; rounds and reload persist; manual removal is independent")
    context.close()


def exam_results_mark_flow(browser, base_url, errors):
    context, page = new_page(browser, base_url, errors)
    select_mode(page, "exam")
    page.locator('[data-setting="ticketId"]').select_option(FIRST_TICKET_ID)
    action(page, "start").click()
    choose_answer(page, FIRST, correct=False)
    expect(page.locator(".feedback")).to_have_count(0)
    action(page, "finish").first.click()
    action(page, "confirm-finish").click()
    expect(page.locator(".results h1")).to_be_visible()
    expect(bookmark(page, FIRST)).to_have_attribute("aria-pressed", "false")
    graded = stored(page)
    bookmark(page, FIRST).click()
    expect(bookmark(page, FIRST)).to_have_attribute("aria-pressed", "true")
    assert stored(page)["difficult"] == [FIRST["id"]]
    assert FIRST["id"] in stored(page)["mistakes"]
    assert stored(page, "exam") == graded["modes"]["exam"]
    assert stored(page)["exams"] == graded["exams"]
    navigate(page, "mistakes")
    expect(bookmark(page, FIRST)).to_have_attribute("aria-pressed", "true")
    bookmark(page, FIRST).click()
    assert stored(page)["difficult"] == []
    assert stored(page)["mistakes"] == graded["mistakes"]
    print("PASS wrong exam answer can be marked in results or error list without changing grades or clearing errors")
    context.close()


def remove_during_exercise_flow(browser, base_url, errors):
    context, page = new_page(browser, base_url, errors)
    marks = [FIRST["id"], SECOND["id"]]
    page.evaluate("""({key, marks}) => {
        const state = JSON.parse(localStorage.getItem(key));
        state.difficult = marks;
        localStorage.setItem(key, JSON.stringify(state));
    }""", {"key": STORAGE_KEY, "marks": marks})
    page.reload()
    wait_home(page)
    resume_difficult(page)
    choose_answer(page, FIRST, correct=False)
    action(page, "check").click()
    bookmark(page, FIRST).click()
    expect(page.locator(".question-text")).to_have_text(SECOND["text"])
    expect(page.locator(".feedback")).to_have_count(0)
    assert stored(page)["difficult"] == [SECOND["id"]]
    assert stored(page)["mistakes"] == [FIRST["id"]]
    bookmark(page, SECOND).click()
    expect(page.locator(".empty-state")).to_be_visible()
    expect(page.locator(".question-text")).to_have_count(0)
    assert stored(page)["difficult"] == []
    assert stored(page, "difficult")["session"] is None
    assert stored(page)["mistakes"] == [FIRST["id"]]
    print("PASS unmarking the current exercise advances safely; unmarking the final question opens the empty collection")
    context.close()


def mobile_difficult_flow(browser, base_url, errors):
    context, page = new_page(browser, base_url, errors, mobile=True)
    longest = max(ALL_QUESTIONS, key=lambda question: len(question["text"]))
    marks = list(dict.fromkeys((FIRST["id"], longest["id"])))
    page.evaluate("""({key, marks}) => {
        const state = JSON.parse(localStorage.getItem(key));
        state.difficult = marks;
        localStorage.setItem(key, JSON.stringify(state));
    }""", {"key": STORAGE_KEY, "marks": marks})
    page.reload()
    wait_home(page)
    for width in (320, 390):
        page.set_viewport_size({"width": width, "height": 844})
        no_overflow(page, f"difficult home {width}px")
        navigate(page, "difficult")
        expect(page.locator(".list-question")).to_have_count(len(marks))
        no_overflow(page, f"difficult list {width}px")
        action(page, "practice-difficult").click()
        expect(page.locator(".question-text")).to_have_text(FIRST["text"])
        no_overflow(page, f"difficult exercise {width}px")
        navigate(page, "home")
    resume_difficult(page)
    choose_answer(page, FIRST, correct=False)
    action(page, "check").click()
    expect(page.locator(".feedback.negative")).to_be_visible()
    action(page, "next").click()
    expect(page.locator(".question-text")).to_have_text(longest["text"])
    choose_answer(page, longest, correct=False)
    action(page, "check").click()
    expect(page.locator(".feedback.negative")).to_be_visible()
    for width in (320, 390):
        page.set_viewport_size({"width": width, "height": 844})
        no_overflow(page, f"difficult feedback {width}px")
    page.screenshot(path="/tmp/boo-difficult-mobile.png", full_page=True)
    print("PASS difficult home, list, exercise, and checked feedback fit mobile widths 320/390px")
    context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:3000")
    parser.add_argument("--chromium", default="/usr/bin/chromium")
    args = parser.parse_args()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=args.chromium, headless=True, args=["--no-sandbox"]
        )
        errors = []
        marked_wrong_and_cycles_flow(browser, args.base_url, errors)
        exam_results_mark_flow(browser, args.base_url, errors)
        remove_during_exercise_flow(browser, args.base_url, errors)
        mobile_difficult_flow(browser, args.base_url, errors)
        browser.close()
        assert not errors, f"Browser errors: {errors}"
    print("Difficult-question browser checks passed; screenshot: /tmp/boo-difficult-mobile.png")


if __name__ == "__main__":
    main()
