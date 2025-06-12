use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;

pub struct ZoxideScores {
    pub scores: HashMap<String, f64>,
}

impl Default for ZoxideScores {
    fn default() -> Self {
        Self::new()
    }
}

impl ZoxideScores {
    pub fn new() -> Self {
        ZoxideScores {
            scores: Self::load_zoxide_scores(),
        }
    }

    pub fn get_score(&self, path: &str) -> f64 {
        let canonical_path = PathBuf::from(path)
            .canonicalize()
            .unwrap_or(PathBuf::from(path));

        self.scores
            .get(&canonical_path.to_string_lossy().into_owned())
            .copied()
            .unwrap_or(0.0)
    }

    fn load_zoxide_scores() -> HashMap<String, f64> {
        let output = match Command::new("zoxide").args(["query", "-ls"]).output() {
            Ok(output) => output,
            Err(_) => return HashMap::new(),
        };

        if !output.status.success() {
            return HashMap::new();
        }

        let mut scores = HashMap::new();
        let output_str = String::from_utf8_lossy(&output.stdout);

        for line in output_str.lines() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 2 {
                if let Ok(score) = parts[0].parse::<f64>() {
                    let path = PathBuf::from(parts[1..].join(" "));
                    if let Ok(canonical) = path.canonicalize() {
                        scores.insert(canonical.to_string_lossy().into_owned(), score);
                    }
                }
            }
        }

        // Normalize scores so the maximum is 100
        if let Some(&max_score) = scores.values().max_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal)) {
            if max_score > 0.0 {
                let scale_factor = 100.0 / max_score;
                for score in scores.values_mut() {
                    *score = (*score * scale_factor).round();
                }
            }
        }

        scores
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_load_zoxide_scores_normalization() {
        // TODO: mock out the call command (use DI)
        let scores = ZoxideScores::load_zoxide_scores();

        // All scores should be normalized to <= 100
        for &score in scores.values() {
            assert!(score <= 100.0, "Score {} should be <= 100", score);
            assert!(score >= 0.0, "Score {} should be >= 0", score);
        }
    }
}
