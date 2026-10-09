#!/usr/bin/env python3
"""Exercise the served trainer in Chromium. Requires Python Playwright.

Run `npm start` first, then:
  python3 tests/browser_smoke.py --base-url http://127.0.0.1:3000
The default Chromium path is /usr/bin/chromium; override with --chromium.
Screenshots are written outside the checkout, under /tmp.
"""

import argparse
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


STORAGE_KEY = "boo-trainer:v1"
DATA = json.loads((Path(__file__).resolve().parents[1] / "public/questions.json").read_text())
FIRST_TICKET = DATA["tickets"][0]
FIRST = FIRST_TICKET["questions"][0]
SECOND = FIRST_TICKET["questions"][1]


def action(page, name, extra=""):
    return page.locator(f'[data-action="{name}"]{extra}')


def navigate(page, destination):
    action(page, "navigate", f'[data-page="{destination}"]').first.click()


def stored(page):
    return page.evaluate("key => JSON.parse(localStorage.getItem(key))", STORAGE_KEY)


def choose_answer(page, question, correct=True):
    option = question["correctOptionId"]
    if not correct:
        option = next(item["id"] for item in question["options"] if item["id"] != option)
    action(page, "answer", f'[data-option="{option}"]').click()
    return option


def no_overflow(page, label):
    size = page.evaluate("({viewport: innerWidth, content: document.documentElement.scrollWidth})")
    assert size["content"] <= size["viewport"] + 1, f"Horizontal overflow on {label}: {size}"


def wait_home(page):
    expect(page.locator(".page-heading h1")).to_have_text("Подготовьтесь спокойно.")


def monitor(page, errors):
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)


def desktop_flow(browser, base_url, errors):
    context = browser.new_context(viewport={"width": 1440, "height": 1080})
    page = context.new_page()
    monitor(page, errors)
    page.goto(base_url)
    wait_home(page)
    expect(page.locator(".stat-card")).to_have_count(3)
    assert page.locator('[data-setting="ticketId"] option').count() == 21
    no_overflow(page, "desktop home")

    page.locator('[data-setting="ticketId"]').select_option("1")
    action(page, "start").click()
    expect(page.locator(".question-text")).to_have_text(FIRST["text"])
    expect(action(page, "check")).to_be_disabled()
    wrong = choose_answer(page, FIRST, correct=False)
    expect(page.locator(".feedback")).to_have_count(0)
    action(page, "check").click()
    expect(page.locator(".feedback.negative")).to_contain_text(f'вариант {FIRST["correctOptionId"]}')
    expect(page.locator(f'.answer.correct[data-option="{FIRST["correctOptionId"]}"]')).to_be_disabled()
    expect(page.locator(f'.answer.incorrect[data-option="{wrong}"]')).to_be_visible()
    progress = stored(page)
    assert progress["mistakes"] == [FIRST["id"]]
    assert progress["answers"][FIRST["id"]] == {"attempts": 1, "correct": 0}

    page.reload()
    wait_home(page)
    action(page, "resume").click()
    expect(page.locator(".feedback.negative")).to_be_visible()
    assert stored(page) == progress, "Reload must not repeat grading"
    action(page, "next").click()
    expect(page.locator(".question-text")).to_have_text(SECOND["text"])
    choose_answer(page, SECOND)
    action(page, "check").click()
    expect(page.locator(".feedback.positive")).to_be_visible()
    assert stored(page)["answers"][SECOND["id"]] == {"attempts": 1, "correct": 1}

    navigate(page, "mistakes")
    expect(page.locator(".list-question")).to_have_count(1)
    expect(page.locator(".list-question h2")).to_have_text(FIRST["text"])
    before_cancel = stored(page)
    action(page, "review").click()
    expect(page.locator("dialog[open]")).to_contain_text("Начать новую")
    action(page, "cancel-finish").click()
    expect(page.locator("dialog[open]")).to_have_count(0)
    assert stored(page) == before_cancel, "Cancel replacement must preserve the current training"
    action(page, "review").click()
    action(page, "confirm-finish").click()
    expect(page.locator(".question-text")).to_have_text(FIRST["text"])
    assert stored(page)["session"]["questionIds"] == [FIRST["id"]]
    choose_answer(page, FIRST)
    action(page, "check").click()
    expect(page.locator(".feedback.positive")).to_be_visible()
    assert stored(page)["mistakes"] == []
    assert stored(page)["answers"][FIRST["id"]] == {"attempts": 2, "correct": 1}
    action(page, "next").click()
    expect(page.locator(".results h1")).to_have_text("Вы стали на шаг увереннее.")
    expect(page.locator(".result-stats > div").nth(0)).to_contain_text("1 / 1")
    print("PASS learning, feedback, persistence, cancellation, and mistake correction")

    navigate(page, "home")
    action(page, "mode", '[data-mode="exam"]').click()
    page.locator('[data-setting="ticketId"]').select_option("1")
    page.locator('[data-setting="minutes"]').select_option("5")
    page.locator('[data-setting="allowedErrors"]').select_option("0")
    action(page, "start").click()
    expect(page.locator("#timer")).to_be_visible()
    original_deadline = stored(page)["session"]["deadline"]
    choose_answer(page, FIRST, correct=False)
    action(page, "next").click()
    action(page, "previous").click()
    expect(page.locator(".answer.chosen")).to_have_count(1)
    choose_answer(page, FIRST)
    action(page, "jump", '[data-index="1"]').click()
    page.reload()
    wait_home(page)
    action(page, "resume").click()
    expect(page.locator(".question-text")).to_have_text(SECOND["text"])
    assert stored(page)["session"]["deadline"] == original_deadline, "Exam reload must preserve deadline"
    for index, question in enumerate(FIRST_TICKET["questions"][1:], start=1):
        expect(page.locator(".question-text")).to_have_text(question["text"])
        choose_answer(page, question)
        expect(page.locator(".feedback, .answer.correct, .answer.incorrect")).to_have_count(0)
        if index < 9:
            action(page, "next").click()
    action(page, "finish").first.click()
    expect(page.locator("dialog[open]")).to_contain_text("Все ответы выбраны")
    action(page, "cancel-finish").click()
    assert stored(page)["session"]["status"] == "active"
    action(page, "finish").first.click()
    action(page, "confirm-finish").click()
    expect(page.locator(".results h1")).to_have_text("Отлично, экзамен сдан!")
    expect(page.locator(".result-stats > div").nth(0)).to_contain_text("10 / 10")
    assert stored(page)["exams"][-1]["correct"] == 10
    assert stored(page)["exams"][-1]["allowedErrors"] == 0
    navigate(page, "history")
    expect(page.locator(".history-item")).to_have_count(1)
    expect(page.locator(".history-score")).to_contain_text("10 / 10")
    expect(page.locator(".history-score")).to_contain_text("Экзамен сдан")
    print("PASS exam navigation, hidden feedback, deadline persistence, grading, and history")

    navigate(page, "home")
    action(page, "mode", '[data-mode="exam"]').click()
    page.locator('[data-setting="ticketId"]').select_option("1")
    page.locator('[data-setting="minutes"]').select_option("5")
    page.locator('[data-setting="allowedErrors"]').select_option("0")
    action(page, "start").click()
    choose_answer(page, FIRST)
    page.evaluate("""key => {
        const value = JSON.parse(localStorage.getItem(key));
        value.session.deadline = Date.now() - 1000;
        value.session.startedAt = value.session.deadline - 300000;
        localStorage.setItem(key, JSON.stringify(value));
    }""", STORAGE_KEY)
    page.reload()
    expect(page.locator(".results h1")).to_have_text("Ещё немного практики.")
    expect(page.locator(".result-stats > div").nth(0)).to_contain_text("1 / 10")
    expect(page.locator(".result-stats > div").nth(1)).to_contain_text("пропущено: 9")
    expect(page.locator(".review-question")).to_have_count(9)
    expired = stored(page)
    assert len(expired["exams"]) == 2
    assert expired["exams"][-1]["duration"] == 300000
    assert expired["session"]["status"] == "finished"
    page.reload()
    wait_home(page)
    assert stored(page) == expired, "Expired exam must be graded only once across reloads"
    expect(action(page, "resume")).to_have_count(0)
    print("PASS automatic completion of expired exam, unanswered grading, and idempotent reload")
    page.screenshot(path="/tmp/boo-desktop.png", full_page=True)
    context.close()


def mobile_flow(browser, base_url, errors):
    context = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    page = context.new_page()
    monitor(page, errors)
    page.goto(base_url)
    wait_home(page)
    for width in (320, 390, 768):
        page.set_viewport_size({"width": width, "height": 844})
        no_overflow(page, f"home {width}px")
    page.set_viewport_size({"width": 390, "height": 844})
    page.screenshot(path="/tmp/boo-mobile.png", full_page=True)
    navigate(page, "tickets")
    expect(page.locator(".ticket-card")).to_have_count(20)
    no_overflow(page, "mobile tickets")
    action(page, "ticket-learn", '[data-ticket="1"]').click()
    choose_answer(page, FIRST, correct=False)
    action(page, "check").click()
    expect(page.locator(".feedback.negative")).to_be_visible()
    no_overflow(page, "mobile feedback")
    navigate(page, "mistakes")
    expect(page.locator(".list-question")).to_have_count(1)
    no_overflow(page, "mobile mistakes")
    action(page, "review").click()
    no_overflow(page, "mobile confirmation")
    action(page, "confirm-finish").click()
    choose_answer(page, FIRST)
    action(page, "check").click()
    action(page, "next").click()
    expect(page.locator(".results h1")).to_be_visible()
    no_overflow(page, "mobile results")
    navigate(page, "history")
    expect(page.locator(".empty-state")).to_be_visible()
    no_overflow(page, "mobile history")
    print("PASS mobile navigation, answer flow, confirmation, and layout at 320/390/768px")
    context.close()


def failed_load_flow(browser, base_url):
    context = browser.new_context()
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.route("**/questions.json", lambda route: route.fulfill(status=503, body="Temporarily unavailable"))
    page.goto(base_url)
    expect(page.locator(".error-state h1")).to_have_text("Не удалось открыть тренажёр")
    expect(page.locator(".error-state")).to_contain_text("503")
    page.unroute("**/questions.json")
    page.locator("#retry").click()
    wait_home(page)
    assert not errors, f"Uncaught error during failed-load recovery: {errors}"
    print("PASS failed question download and retry recovery")
    context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:3000")
    parser.add_argument("--chromium", default="/usr/bin/chromium")
    args = parser.parse_args()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=args.chromium, headless=True, args=["--no-sandbox"])
        errors = []
        desktop_flow(browser, args.base_url, errors)
        mobile_flow(browser, args.base_url, errors)
        failed_load_flow(browser, args.base_url)
        browser.close()
        assert not errors, f"Browser errors: {errors}"
    print("Browser smoke passed; screenshots: /tmp/boo-desktop.png, /tmp/boo-mobile.png")


if __name__ == "__main__":
    main()
