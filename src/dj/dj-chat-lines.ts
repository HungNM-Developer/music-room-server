/**
 * The DJ's own small-talk lines (spec 2026-10-18-dj-translator, "Câu không liên quan"): used
 * when the AI's line is missing, too long or filtered. Light, office-friendly, nudging back to
 * music; never the same line twice in a row in a room.
 */
export const CHAT_LINES: { vi: string[]; en: string[] } = {
  vi: [
    'Mình chỉ giỏi mỗi vụ nhạc thôi, nhưng nghe một bài chill thì chuyện gì cũng nhẹ hơn đó.',
    'Câu này khó quá, để mình bật một bài cho não nghỉ ngơi xíu nhé? Gõ "@DJ vài bài chill".',
    'Mình là DJ chứ không phải thầy bói, nhưng mình đoán bạn cần một bài thật bắt tai.',
    'Nghe nói nhạc giúp năng suất tăng 200%. Số liệu do mình tự nghĩ ra, nhưng thử xem!',
    'Mình chưa hiểu lắm, nhưng mình hiểu rất rõ cảm giác muốn nghe một bài hay.',
    'Ồ, chủ đề thú vị đấy! Tiếc là mình chỉ có đĩa nhạc trong tay.',
    'Hỏi khó thế, phạt bạn chọn một bài cho cả phòng nghe nào.',
    'Mình đang bận lau đĩa, nhưng vẫn kịp nhắc: "@DJ thêm bài của <ca sĩ>" là mình chạy ngay.',
    'Đời có lúc thăng lúc trầm, playlist thì lúc nào cũng có bài hợp.',
    'Mình không trả lời được câu này, nhưng mình trả lời được câu "nghe gì bây giờ".',
    'Cà phê chưa? Nhạc chưa? Thiếu cái nào mình lo được cái thứ hai.',
    'Đang giờ làm mà, hay để mình bật nhạc tập trung nhé?',
    'Cái này để Google lo, còn nhạc thì để DJ lo.',
    'Tai mình chỉ nghe được nốt nhạc thôi. Thử "@DJ gợi ý bài giống bài đang phát" xem.',
    'Mình đề nghị: bớt lo một chút, thêm một bài vào hàng chờ.',
    'Hôm nay ai cũng cần một bài hát riêng. Bạn muốn bài vui hay bài buồn?',
    'Mình là DJ văn phòng, chuyên trị deadline bằng giai điệu.',
    'Không hiểu nhưng vẫn ủng hộ! Giờ quay lại chọn nhạc nhé.',
    'Nếu đây là câu đố thì đáp án là... một bài Sơn Tùng?',
    'Mình vừa xoay đĩa ba vòng mà vẫn chưa nghĩ ra. Mình chọn nhạc cho bạn nhé?',
    'Chuyện đó mình không rành, chuyện nhạc thì mời bạn cứ hỏi.',
    'Mệt thì nghỉ, buồn thì nghe nhạc, vui thì... cũng nghe nhạc.',
    'Mình đề xuất giải pháp duy nhất mình biết: thêm nhạc.',
    'Câu này để dành cho giờ giải lao, còn bây giờ là giờ của âm nhạc.',
    'Bạn nói gì mình cũng gật gù theo nhịp, nhưng chưa làm gì được đâu nha.',
    'Mình là DJ, không phải chatbot vạn năng. Nhưng DJ thì có playlist vạn năng.',
    'Đã ghi nhận! (vào sổ những câu mình không hiểu) Giờ nghe gì đây?',
    'Mỗi câu hỏi khó đổi được một bài hay. Bạn chọn bài đi!',
    'Mình chỉ biết đếm nhịp 1, 2, 3, 4. Phần còn lại nhờ bạn.',
    'Câu này vượt quá tần số của mình rồi. Chỉnh về kênh âm nhạc nhé!',
  ],
  en: [
    'I only know music, but a good song makes almost anything better.',
    'Tough one. How about a song while you think? Try "@DJ some chill songs".',
    "I'm a DJ, not a fortune teller, but I predict you need a catchy tune.",
    'Music boosts productivity by 200%. I made that number up, but try it anyway!',
    "Didn't quite get that, but I totally get wanting a great song.",
    'Interesting topic! Sadly all I have are records.',
    'That was hard. Your penalty: pick a song for the whole room.',
    'Busy polishing records, but "@DJ add songs by <artist>" and I am on it.',
    'Life has ups and downs; the playlist always has the right song.',
    'I cannot answer that one, but I can answer "what should we play now".',
    'Coffee? Music? I can only help with the second one.',
    "It's work time. Shall I put on something to focus?",
    'Leave that to search engines; leave the music to the DJ.',
    'My ears only hear notes. Try "@DJ suggest songs like this one".',
    'My proposal: worry a little less, queue a little more.',
    'Everyone deserves a song today. Something happy or something sad?',
    'Office DJ here, fixing deadlines with melodies.',
    "Didn't understand, still supportive! Back to the music?",
    'If that was a riddle, the answer is... another song?',
    'Spun the record three times and still no idea. Want me to pick a song?',
    'Not my area. Music is, so ask away.',
    'Tired? Rest. Sad? Music. Happy? Also music.',
    'The only fix I know: add more music.',
    "Let's save that for the coffee break. Now it's music time.",
    "I'm nodding along to the beat, but I can't do anything with that.",
    "I'm a DJ, not an everything-bot. But I do have an everything-playlist.",
    'Noted! (in my book of things I do not understand) What shall we play?',
    'Every hard question earns one good song. Your pick!',
    'I can only count to four, in beats. The rest is up to you.',
    "That's outside my frequency. Tuning back to music!",
  ],
};

/** A line other than the room's last one; `index` to remember for next time. */
export function chatLine(
  lang: 'vi' | 'en',
  last?: number,
): { text: string; index: number } {
  const lines = CHAT_LINES[lang];
  let index = Math.floor(Math.random() * lines.length);
  if (lines.length > 1 && index === last) index = (index + 1) % lines.length;
  return { text: lines[index], index };
}
