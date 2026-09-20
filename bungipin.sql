CREATE DATABASE IF NOT EXISTS dental_appointments;
USE dental_appointments;

-- Drop Instances *
DROP PROCEDURE IF EXISTS sp_get_all_patient_records;
DROP PROCEDURE IF EXISTS sp_get_patient_record;
DROP PROCEDURE IF EXISTS sp_register_user;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS xrays;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS appointments;
DROP TABLE IF EXISTS services;
DROP TABLE IF EXISTS allergies;
DROP TABLE IF EXISTS prescriptions;
DROP TABLE IF EXISTS health_conditions;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS admin_profiles;
DROP TABLE IF EXISTS employee_profiles;
DROP TABLE IF EXISTS patient_profiles;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
    user_id         INT AUTO_INCREMENT PRIMARY KEY,
    public_id       VARCHAR(10) UNIQUE,       
    first_name      VARCHAR(50)  NOT NULL,
    last_name       VARCHAR(50)  NOT NULL,
    email           VARCHAR(150) NOT NULL UNIQUE,
    phone           VARCHAR(20),
    password_hash   VARCHAR(255) NOT NULL,
    sex             VARCHAR(10),
    role            ENUM('patient','employee','admin') NOT NULL,
    account_status  ENUM('active','suspended') NOT NULL DEFAULT 'active',
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Public ID Procedure
DELIMITER $$
CREATE PROCEDURE sp_register_user(
    IN p_first_name  VARCHAR(50),
    IN p_last_name   VARCHAR(50),
    IN p_email       VARCHAR(150),
    IN p_phone       VARCHAR(20),
    IN p_password_hash VARCHAR(255),
    IN p_sex         VARCHAR(10),
    IN p_role        ENUM('patient','employee','admin'),
    OUT p_new_user_id INT
)
BEGIN
    INSERT INTO users (first_name, last_name, email, phone, password_hash, sex, role)
    VALUES (p_first_name, p_last_name, p_email, p_phone, p_password_hash, p_sex, p_role);

    SET p_new_user_id = LAST_INSERT_ID();

    UPDATE users
    SET public_id = CONCAT(
        CASE p_role
            WHEN 'patient'  THEN 'PAT'
            WHEN 'employee' THEN 'EMP'
            WHEN 'admin'    THEN 'ADM'
            ELSE 'USR'
        END,
        '-', LPAD(p_new_user_id, 4, '0')
    )
    WHERE user_id = p_new_user_id;
END$$
DELIMITER ;

CREATE TABLE patient_profiles (
    patient_id       INT PRIMARY KEY,
    birthday         DATE,
    civil_status     VARCHAR(30),
    secondary_email  VARCHAR(150),
    address          VARCHAR(255),
    pregnancy_status VARCHAR(30),
    FOREIGN KEY (patient_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE employee_profiles (
    employee_id   INT PRIMARY KEY,
    staff_code    VARCHAR(30) UNIQUE,
    birthday      DATE,
    civil_status  VARCHAR(30),
    position      VARCHAR(30),
    FOREIGN KEY (employee_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE admin_profiles (
    admin_id          INT PRIMARY KEY,
    permission_level  VARCHAR(30),
    FOREIGN KEY (admin_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE audit_logs (
    log_id        INT AUTO_INCREMENT PRIMARY KEY,
    admin_id      INT NOT NULL,
    action        VARCHAR(100) NOT NULL,
    target_table  VARCHAR(50)  NOT NULL,
    target_id     INT NOT NULL,
    notes         TEXT,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (admin_id) REFERENCES admin_profiles(admin_id) ON DELETE CASCADE
);

CREATE TABLE health_conditions (
    condition_id  INT AUTO_INCREMENT PRIMARY KEY,
    patient_id    INT NOT NULL,
    description   VARCHAR(255) NOT NULL,
    FOREIGN KEY (patient_id) REFERENCES patient_profiles(patient_id) ON DELETE CASCADE
);

CREATE TABLE prescriptions (
    prescription_id  INT AUTO_INCREMENT PRIMARY KEY,
    patient_id       INT NOT NULL,
    medication_name  VARCHAR(100) NOT NULL,
    dosage           VARCHAR(50),
    FOREIGN KEY (patient_id) REFERENCES patient_profiles(patient_id) ON DELETE CASCADE
);

CREATE TABLE allergies (
    allergy_id   INT AUTO_INCREMENT PRIMARY KEY,
    patient_id   INT NOT NULL,
    allergen     VARCHAR(100) NOT NULL,
    FOREIGN KEY (patient_id) REFERENCES patient_profiles(patient_id) ON DELETE CASCADE
);

CREATE TABLE services (
    service_id    INT AUTO_INCREMENT PRIMARY KEY,
    label         VARCHAR(100) NOT NULL,
    price         DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    icon          VARCHAR(255),
    is_available  BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE appointments (
    appointment_id      INT AUTO_INCREMENT PRIMARY KEY,
    patient_id          INT NOT NULL,
    employee_id         INT NULL,           -- assigned by staff after booking, not at booking time
    service_id          INT NOT NULL,
    appointment_date    DATE NOT NULL,
    time_slot           TIME NOT NULL,
    appointment_status  ENUM('pending','approved','completed','cancelled') NOT NULL DEFAULT 'pending',
    queue_status         ENUM('pending','waiting','ongoing','completed') NULL,
    patient_note         VARCHAR(255),
    dentist_note          VARCHAR(255),
    created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (patient_id)  REFERENCES patient_profiles(patient_id) ON DELETE CASCADE,
    FOREIGN KEY (employee_id) REFERENCES employee_profiles(employee_id) ON DELETE SET NULL,
    FOREIGN KEY (service_id)  REFERENCES services(service_id) ON DELETE RESTRICT,
    
    UNIQUE KEY unique_employee_slot (employee_id, appointment_date, time_slot)
);

CREATE TABLE payments (
    payment_id       INT AUTO_INCREMENT PRIMARY KEY,
    appointment_id   INT NOT NULL UNIQUE,
    amount           DECIMAL(10,2) NOT NULL,
    payment_date     DATE,
    method           ENUM('cash','card','online') NOT NULL,
    status           ENUM('pending','paid','refunded') NOT NULL DEFAULT 'pending',
    FOREIGN KEY (appointment_id) REFERENCES appointments(appointment_id) ON DELETE CASCADE
);

CREATE TABLE xrays (
    xray_id         INT AUTO_INCREMENT PRIMARY KEY,
    patient_id      INT NOT NULL,
    appointment_id  INT NULL,
    uploaded_by     INT NOT NULL,
    file_url        VARCHAR(255) NOT NULL,
    uploaded_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (patient_id)     REFERENCES patient_profiles(patient_id) ON DELETE CASCADE,
    FOREIGN KEY (appointment_id) REFERENCES appointments(appointment_id) ON DELETE SET NULL,
    FOREIGN KEY (uploaded_by)    REFERENCES employee_profiles(employee_id) ON DELETE RESTRICT
);

CREATE TABLE messages (
    message_id   INT AUTO_INCREMENT PRIMARY KEY,
    sender_id    INT NOT NULL,
    receiver_id  INT NOT NULL,
    content      TEXT,
    file_url     VARCHAR(255),
    sent_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_read      BOOLEAN NOT NULL DEFAULT FALSE,
    FOREIGN KEY (sender_id)   REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (receiver_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE notifications (
    notification_id  INT AUTO_INCREMENT PRIMARY KEY,
    user_id          INT NOT NULL,
    type             VARCHAR(50) NOT NULL,
    title            VARCHAR(100) NOT NULL,
    message          TEXT,
    appointment_id   INT NULL,
    message_id       INT NULL,
    is_read          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id)        REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (appointment_id) REFERENCES appointments(appointment_id) ON DELETE CASCADE,
    FOREIGN KEY (message_id)     REFERENCES messages(message_id) ON DELETE CASCADE,
    -- ensures a notification references at most one source, never both
    CONSTRAINT chk_single_source CHECK (
        NOT (appointment_id IS NOT NULL AND message_id IS NOT NULL)
    )
);

DELIMITER $$
CREATE PROCEDURE sp_get_all_patient_records()
BEGIN
    SELECT JSON_OBJECT(
        'patient_id', pp.patient_id,
        'public_id', u.public_id,
        'first_name', u.first_name,
        'last_name', u.last_name,
        'sex', u.sex,
        'birthday', pp.birthday,
        'email', u.email,
        'phone', u.phone,
        'civil_status', pp.civil_status,
        'pregnancy_status', pp.pregnancy_status,
 
        'health_conditions', (
            SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('description', description)), JSON_ARRAY())
            FROM health_conditions WHERE patient_id = pp.patient_id
        ),
 
        'allergies', (
            SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('allergen', allergen)), JSON_ARRAY())
            FROM allergies WHERE patient_id = pp.patient_id
        ),
 
        'prescriptions', (
            SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('medication_name', medication_name, 'dosage', dosage)), JSON_ARRAY())
            FROM prescriptions WHERE patient_id = pp.patient_id
        ),
 
        'xrays', (
            SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('appointment_id', appointment_id, 'file_url', file_url)), JSON_ARRAY())
            FROM xrays WHERE patient_id = pp.patient_id
        ),
 
        'last_visit', (
            SELECT MAX(appointment_date) FROM appointments
            WHERE patient_id = pp.patient_id AND appointment_status = 'completed'
        ),
 
        'ongoing_appointment', (
            SELECT JSON_OBJECT(
                'appointment_id', appointment_id,
                'dentist_note', COALESCE(dentist_note, ''),
                'patient_note', COALESCE(patient_note, '')
            )
            FROM appointments
            WHERE patient_id = pp.patient_id AND appointment_status IN ('pending', 'approved')
            ORDER BY appointment_date DESC, time_slot DESC
            LIMIT 1
        ),
 
        'past_appointments', (
            SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
                'appointment_id', a.appointment_id,
                'appointment_date', a.appointment_date,
                'service_label', s.label,
                'dentist_note', COALESCE(a.dentist_note, ''),
                'patient_note', COALESCE(a.patient_note, '')
            )), JSON_ARRAY())
            FROM appointments a
            JOIN services s ON a.service_id = s.service_id
            WHERE a.patient_id = pp.patient_id AND a.appointment_status = 'completed'
        )
    ) AS patient_record
    FROM patient_profiles pp
    JOIN users u ON pp.patient_id = u.user_id
    ORDER BY u.user_id;
END$$
DELIMITER ;

-- Double Check
CALL sp_register_user('Juan', 'Dela Cruz', 'juan.delacruz@email.com', '0917 123 4567', '<hashed_pw>', 'M', 'patient', @uid1);
CALL sp_register_user('Maria', 'Santos', 'maria.santos@email.com', '0918 987 6543', '<hashed_pw>', 'F', 'patient', @uid2);

CALL sp_register_user('Ramon', 'Cruz', 'ramon.cruz@example.com', '09201112222', '<hashed_pw>', 'M', 'employee', @uid3);

INSERT INTO patient_profiles (patient_id, birthday, civil_status, pregnancy_status) VALUES
(1, '1990-05-14', 'Single', NULL),
(2, '1995-08-22', 'Married', '2nd Trimester');

INSERT INTO employee_profiles (employee_id, staff_code, birthday, civil_status) VALUES
(3, 'STF-2026-001', '1985-06-10', 'Married', 'dentist');

INSERT INTO health_conditions (patient_id, description) VALUES
(2, 'Asthma');

INSERT INTO allergies (patient_id, allergen) VALUES
(1, 'Penicillin');

INSERT INTO prescriptions (patient_id, medication_name, dosage) VALUES
(2, 'Albuterol inhaler', 'As needed');

INSERT INTO services (service_id, label, price, icon, is_available) VALUES
(1, 'Checkup', 300.00, 'checkup-icon', TRUE),
(2, 'Cleaning', 800.00, 'cleaning-icon', TRUE);

INSERT INTO appointments (appointment_id, patient_id, employee_id, service_id, appointment_date, time_slot, appointment_status, dentist_note, patient_note) VALUES
(150, 1, 3, 1, '2025-06-02', '09:00:00', 'completed', 'No issues found.', 'Routine checkup'),
(140, 2, 3, 2, '2025-10-15', '11:00:00', 'completed', 'Mild plaque buildup.', 'Regular cleaning');

INSERT INTO appointments (appointment_id, patient_id, employee_id, service_id, appointment_date, time_slot, appointment_status, dentist_note, patient_note) VALUES
(201, 1, 3, 1, CURDATE(), '10:00:00', 'approved', '', 'Tooth pain, upper left molar'),
(202, 2, 3, 2, CURDATE(), '11:30:00', 'approved', '', 'Reporting gum sensitivity during brushing');

INSERT INTO xrays (patient_id, appointment_id, uploaded_by, file_url) VALUES
(1, 150, 3, 'https://images.unsplash.com/photo-1516549655169-df83a0774514?w=300'),
(2, 140, 3, 'https://images.unsplash.com/photo-1588776814546-1ffcf47267a5?w=300');


